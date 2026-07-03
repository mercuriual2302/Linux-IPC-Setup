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

// Packages that need a companion initialisation step beyond a plain apt
// install, keyed by the password field they need. Right now this is just
// TF2000 HMI Server, but written as a lookup so a future package with the
// same shape (install + one-time init with its own password) is a one-line
// addition rather than another silent gap like this one turned out to be.
const PACKAGE_INIT_REQUIREMENTS = {
  'tf2000-hmi-server': 'tf2000Password'
};

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

  if (recipe.credentials !== undefined) {
    if (!isPlainObject(recipe.credentials)) {
      errors.push('credentials must be an object');
    } else {
      ['beckhoffUsername', 'beckhoffPassword', 'tf2000Password'].forEach((key) => {
        const v = recipe.credentials[key];
        if (v !== undefined && v !== null && typeof v !== 'string') {
          errors.push(`credentials.${key} must be a string or null`);
        }
      });
    }
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
//   amsNetId  - string, e.g. "5.59.21.26.1.1" (per manual section 8.5) - reference only
//   beckhoffUser/beckhoffPass - MyBeckhoff account for this recipe's apt steps
//   tf2000Pass - password used to initialise TF2000 HMI Server, if included
function buildRecipeFromCapture({ name, sourceHost, info, ifaces, packages, firewall, tf1200, amsNetId, beckhoffUser, beckhoffPass, tf2000Pass } = {}) {
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

  // Network/identity is captured for reference only (see IDENTITY_SECTIONS).
  // Hostname and AMS NetID are per-device the same way an IP is (manual
  // section 8.5 - changing AMS NetID changes the device's address on the
  // TwinCAT network) so they live here too, never auto-applied.
  if ((Array.isArray(ifaces) && ifaces.length) || amsNetId || (info && info.HOSTNAME)) {
    sections.network = {
      note: 'Per-device identity - not applied by default',
      interfaces: (ifaces || []).map(i => ({ name: i.name, ip: i.ip, state: i.state })),
      hostname: (info && info.HOSTNAME) || null,
      amsNetId: amsNetId || null
    };
  }

  if (tf1200 && tf1200.config && isPlainObject(tf1200.config)) {
    sections.tf1200 = { config: tf1200.config };
  }

  // Credentials live outside `sections` deliberately: they're not a "desired
  // device state" a user ticks on and off like feed/packages/firewall, they're
  // supporting data those steps need to run at all. Kept locally so a saved
  // recipe never needs re-typing on repeat applies - stripSecretsForExport()
  // removes the passwords before a recipe is ever written to a shareable file.
  const credentials = {
    beckhoffUsername: beckhoffUser || null,
    beckhoffPassword: beckhoffPass || null,
    tf2000Password: tf2000Pass || null
  };

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
    sections,
    credentials
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

// True if applying this recipe's currently-ticked sections would touch apt
// (feed switch or package install), meaning MyBeckhoff credentials are
// required to authenticate against the Beckhoff package server. Takes the
// same `include` map buildApplyPlan does, so this reflects what's actually
// about to run rather than everything the recipe could theoretically do.
function needsBeckhoffAuth(recipe, include) {
  const s = (recipe && recipe.sections) || {};
  const wants = (key) => !include || include[key] === true;
  return !!((wants('feed') && s.feed) || (wants('packages') && s.packages && s.packages.length));
}

// True if the ticked packages include one that needs a companion init step
// requiring its own password (see PACKAGE_INIT_REQUIREMENTS).
function needsTf2000Password(recipe, include) {
  const s = (recipe && recipe.sections) || {};
  if (include && include.packages !== true) return false;
  return !!(s.packages || []).some(p => p && PACKAGE_INIT_REQUIREMENTS[p.name] === 'tf2000Password');
}

// Deep-clones a recipe with credential passwords removed. Usernames are kept
// (not secret, and tell whoever imports the file which account to supply a
// password for) - only the two password fields are stripped. Always call
// this before a recipe is written anywhere outside the local recipes folder.
function stripSecretsForExport(recipe) {
  const copy = JSON.parse(JSON.stringify(recipe));
  if (copy.credentials) {
    copy.credentials.beckhoffPassword = null;
    copy.credentials.tf2000Password = null;
  }
  return copy;
}

module.exports = {
  RECIPE_VERSION,
  IDENTITY_SECTIONS,
  PACKAGE_INIT_REQUIREMENTS,
  validateRecipe,
  buildRecipeFromCapture,
  buildApplyPlan,
  listSections,
  needsBeckhoffAuth,
  needsTf2000Password,
  stripSecretsForExport
};