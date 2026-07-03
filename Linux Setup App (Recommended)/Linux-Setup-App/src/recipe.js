// src/recipe.js - provisioning recipe schema, capture, and apply-plan logic.
//
// A recipe is a portable JSON description of a CX's desired software state:
// feed channel, TwinCAT packages (optionally version-pinned), firewall rules,
// and TF1200 UI Client config. Capture reads it off a known-good CX; apply
// replays it onto a fresh one. Fleet mode (phase 2) applies one recipe across
// many CXs.
//
// Deliberately pure: no SSH, no Electron, no fs. It turns "CX info in" into
// "recipe out" and "recipe in" into "an ordered list of steps to run out".
// The actual running of those steps lives in main.js, which already has the
// handlers (cx:switch-feed, cx:firewall, run-setup, run-tf1200). That split is
// what makes this file unit-testable and reusable.

const RECIPE_VERSION = 1;

// Identity fields are per-device: cloning them across a fleet would hand every
// CX the same IP / hostname / AMS NetID. So the recipe captures network state
// for reference, but apply defaults to SKIPPING it unless the user explicitly
// opts in per-run. This is the single most important safety property here.
const IDENTITY_SECTIONS = ['network'];

// validation

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Returns { ok, errors: [...] }. Never throws - callers show errors to the user.
function validateRecipe(recipe) {
  const errors = [];
  if (!isPlainObject(recipe)) {
    return { ok: false, errors: ['Recipe is not an object'] };
  }
  if (recipe.schema !== 'linux-ipc-recipe') {
    errors.push('Missing or wrong schema marker (expected "linux-ipc-recipe")');
  }
  if (typeof recipe.version !== 'number') {
    errors.push('Missing numeric version');
  } else if (recipe.version > RECIPE_VERSION) {
    errors.push(`Recipe version ${recipe.version} is newer than this app supports (${RECIPE_VERSION}). Update the app.`);
  }
  if (!isPlainObject(recipe.sections)) {
    errors.push('Missing sections object');
    return { ok: errors.length === 0, errors };
  }

  const s = recipe.sections;

  if (s.feed !== undefined) {
    if (!isPlainObject(s.feed) || typeof s.feed.channel !== 'string') {
      errors.push('feed section must have a string channel');
    } else if (!/^trixie-(stable|unstable)$/.test(s.feed.channel)) {
      errors.push(`feed.channel "${s.feed.channel}" is not a recognised channel`);
    }
  }

  if (s.packages !== undefined) {
    if (!Array.isArray(s.packages)) {
      errors.push('packages section must be an array');
    } else {
      s.packages.forEach((p, i) => {
        if (!isPlainObject(p) || typeof p.name !== 'string' || !p.name) {
          errors.push(`packages[${i}] must have a name`);
        } else if (!/^[A-Za-z0-9._+-]+$/.test(p.name)) {
          errors.push(`packages[${i}] name "${p.name}" has invalid characters`);
        }
        if (p.version !== undefined && p.version !== null && typeof p.version !== 'string') {
          errors.push(`packages[${i}] version must be a string or null`);
        }
      });
    }
  }

  if (s.firewall !== undefined) {
    if (!isPlainObject(s.firewall)) {
      errors.push('firewall section must be an object');
    } else {
      if (typeof s.firewall.enabled !== 'boolean') {
        errors.push('firewall.enabled must be a boolean');
      }
      if (s.firewall.ports !== undefined) {
        if (!Array.isArray(s.firewall.ports)) {
          errors.push('firewall.ports must be an array');
        } else {
          s.firewall.ports.forEach((p, i) => {
            const port = Number(p && p.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              errors.push(`firewall.ports[${i}] has an invalid port`);
            }
            if (p && p.proto !== 'tcp' && p.proto !== 'udp') {
              errors.push(`firewall.ports[${i}] proto must be tcp or udp`);
            }
          });
        }
      }
    }
  }

  if (s.network !== undefined && !isPlainObject(s.network)) {
    errors.push('network section must be an object');
  }

  if (s.tf1200 !== undefined && !isPlainObject(s.tf1200)) {
    errors.push('tf1200 section must be an object');
  }

  return { ok: errors.length === 0, errors };
}

// capture 

// Turns the pieces read off a CX (via existing handlers) into a recipe object.
// Each argument is optional - whatever the caller managed to read gets folded
// in; anything missing is simply left out of the recipe rather than guessed.
//
//   info      - from cx:info      ({ FEED, TC_VER, HOSTNAME, ... } + ifaces)
//   packages  - array of { name, version } the caller resolved as installed
//   firewall  - from cx:read-firewall ({ enabled, ports })
//   tf1200    - from cx:read-tf1200-config ({ config })
function buildRecipeFromCapture({ name, sourceHost, info, ifaces, packages, firewall, tf1200 } = {}) {
  const sections = {};

  if (info && info.FEED && info.FEED !== 'unknown') {
    sections.feed = { channel: info.FEED };
  }

  if (Array.isArray(packages) && packages.length) {
    sections.packages = packages
      .filter(p => p && p.name)
      .map(p => ({ name: p.name, version: p.version || null }));
  }

  if (firewall && typeof firewall.enabled === 'boolean') {
    sections.firewall = {
      enabled: firewall.enabled,
      ports: (firewall.ports || []).map(p => ({
        port: p.port, proto: p.proto, label: p.label || ''
      }))
    };
  }

  // Network is captured for reference only (see IDENTITY_SECTIONS). Store the
  // interface list so a human can read what the source had, but this never
  // auto-applies.
  if (Array.isArray(ifaces) && ifaces.length) {
    sections.network = {
      note: 'Per-device identity - not applied by default',
      interfaces: ifaces.map(i => ({ name: i.name, ip: i.ip, state: i.state }))
    };
  }

  if (tf1200 && tf1200.config && isPlainObject(tf1200.config)) {
    sections.tf1200 = { config: tf1200.config };
  }

  return {
    schema: 'linux-ipc-recipe',
    version: RECIPE_VERSION,
    name: name || 'Untitled recipe',
    capturedAt: new Date().toISOString(),
    sourceHost: sourceHost || null,
    sourceInfo: info ? {
      hostname: info.HOSTNAME || null,
      tcVersion: info.TC_VER || null,
      os: info.OS || null
    } : null,
    sections
  };
}

// apply planning

// Given a validated recipe and a set of per-section apply toggles, produce an
// ordered list of steps for main.js to execute. Order matters: feed before
// packages (so installs pull from the right channel), packages before firewall
// (TwinCAT Functions auto-open ports on install, and we don't want to clobber
// those), firewall before tf1200, everything before any reboot.
//
// opts.include is a set/object of section keys the user ticked. Network is only
// ever included if explicitly asked for AND opts.applyNetwork is true - a
// double gate on the identity-cloning footgun.
function buildApplyPlan(recipe, opts = {}) {
  const include = opts.include || {};
  const steps = [];
  const s = (recipe && recipe.sections) || {};

  const wants = (key) => include[key] === true;

  if (wants('feed') && s.feed) {
    steps.push({ kind: 'feed', label: `Switch feed to ${s.feed.channel}`, data: { channel: s.feed.channel } });
  }

  if (wants('packages') && Array.isArray(s.packages) && s.packages.length) {
    steps.push({
      kind: 'packages',
      label: `Install ${s.packages.length} package(s)`,
      data: { packages: s.packages }
    });
  }

  if (wants('firewall') && s.firewall) {
    const n = (s.firewall.ports || []).length;
    steps.push({
      kind: 'firewall',
      label: s.firewall.enabled ? `Configure firewall (${n} port(s) open)` : 'Disable firewall',
      data: { enable: s.firewall.enabled, ports: s.firewall.ports || [] }
    });
  }

  // Network: guarded twice. Must be ticked AND the explicit applyNetwork flag.
  if (wants('network') && opts.applyNetwork === true && s.network) {
    steps.push({
      kind: 'network',
      label: 'Apply network config (identity - per device)',
      data: s.network,
      identity: true
    });
  }

  if (wants('tf1200') && s.tf1200 && s.tf1200.config) {
    steps.push({ kind: 'tf1200', label: 'Apply TF1200 UI Client config', data: { config: s.tf1200.config } });
  }

  return steps;
}

// Which sections a recipe actually carries, for building apply toggles in the UI.
function listSections(recipe) {
  const s = (recipe && recipe.sections) || {};
  return Object.keys(s).map(key => ({
    key,
    identity: IDENTITY_SECTIONS.includes(key),
    // A short human summary per section for the apply screen
    summary: summariseSection(key, s[key])
  }));
}

function summariseSection(key, val) {
  switch (key) {
    case 'feed': return val.channel;
    case 'packages': return `${val.length} package(s)`;
    case 'firewall': return val.enabled ? `${(val.ports || []).length} port(s), enabled` : 'disabled';
    case 'network': return `${(val.interfaces || []).length} interface(s) - reference only`;
    case 'tf1200': return 'UI Client config';
    default: return '';
  }
}

module.exports = {
  RECIPE_VERSION,
  IDENTITY_SECTIONS,
  validateRecipe,
  buildRecipeFromCapture,
  buildApplyPlan,
  listSections
};