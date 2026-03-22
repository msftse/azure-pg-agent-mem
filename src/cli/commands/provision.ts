/**
 * CLI command: db provision
 *
 * Provisions an Azure PostgreSQL Flexible Server for agent memory
 * using the Azure CLI (`az`). Steps:
 *
 *   1. Verify `az` CLI is installed and logged in
 *   2. Create or reuse resource group
 *   3. Create Azure PostgreSQL Flexible Server (B1ms, PG 16, public access)
 *   4. Enable pgvector extension via server parameter
 *   5. Create `agent_memory` database
 *   6. Add firewall rule for the current public IP
 *   7. Build and save DATABASE_URL to ~/.agent-mem/settings.json
 *   8. Optionally run `db push` (schema + RLS policies)
 */

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { logger } from '../../shared/logger.js';
import { getSetting, setSetting } from '../../shared/settings.js';

const log = logger.child('DB:Provision');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run an az CLI command and return stdout. Throws on non-zero exit. */
function az(cmd: string, opts?: { silent?: boolean; timeoutMs?: number }): string {
  const full = `az ${cmd}`;
  if (!opts?.silent) {
    log.debug('Running', { cmd: full });
  }
  try {
    return execSync(full, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts?.timeoutMs ?? 120_000, // default 2 min
    }).trim();
  } catch (err: unknown) {
    const msg =
      err instanceof Error
        ? (err as Error & { stderr?: string }).stderr || err.message
        : String(err);
    throw new Error(`az command failed: ${full}\n${msg}`);
  }
}

/** Generate a random secure password: 20 chars, mixed case + digits + specials. */
function generatePassword(): string {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const special = '!@#%^&*';
  const all = lower + upper + digits + special;

  // Guarantee at least one of each category, then fill randomly
  const mandatory = [
    lower[crypto.randomInt(lower.length)],
    upper[crypto.randomInt(upper.length)],
    digits[crypto.randomInt(digits.length)],
    special[crypto.randomInt(special.length)],
  ];
  const rest = Array.from({ length: 16 }, () => all[crypto.randomInt(all.length)]);
  // Shuffle everything together
  const chars = [...mandatory, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ProvisionOptions {
  /** Server name (globally unique, becomes <name>.postgres.database.azure.com). */
  name?: string;
  /** Azure resource group. Created if it doesn't exist. */
  resourceGroup?: string;
  /** Azure region. */
  location?: string;
  /** Admin username. */
  adminUser?: string;
  /** Admin password. Auto-generated if omitted. */
  adminPassword?: string;
  /** PostgreSQL SKU. */
  sku?: string;
  /** Database name. */
  database?: string;
  /** Whether to run `db push` after provisioning. */
  pushSchema?: boolean;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function provision(opts: ProvisionOptions = {}): Promise<void> {
  const serverName = opts.name || `agent-mem-pg-${crypto.randomBytes(3).toString('hex')}`;
  const resourceGroup = opts.resourceGroup || 'rg-agent-mem';
  const location = opts.location || 'eastus';
  const adminUser = opts.adminUser || 'agentmemadmin';
  const adminPassword = opts.adminPassword || generatePassword();
  const sku = opts.sku || 'Standard_B1ms';
  const database = opts.database || 'agent_memory';
  const runPush = opts.pushSchema !== false; // default true

  console.log('');
  console.log('Azure PostgreSQL Provisioning for Agent Memory');
  console.log('═'.repeat(48));
  console.log(`  Server name:    ${serverName}`);
  console.log(`  Resource group: ${resourceGroup}`);
  console.log(`  Location:       ${location}`);
  console.log(`  SKU:            ${sku}`);
  console.log(`  Admin user:     ${adminUser}`);
  console.log(`  Database:       ${database}`);
  console.log('');

  // ── Step 1: Verify az CLI ───────────────────────────────────────────────
  console.log('[1/7] Checking Azure CLI...');
  try {
    const ver = az('version --output tsv --query \'"azure-cli"\'', { silent: true });
    console.log(`  ✓ Azure CLI v${ver}`);
  } catch {
    console.error('  ✗ Azure CLI (az) is not installed or not on PATH.');
    console.error('    Install: https://learn.microsoft.com/cli/azure/install-azure-cli');
    process.exitCode = 1;
    return;
  }

  // Check login
  try {
    const account = az('account show --query name -o tsv', { silent: true });
    console.log(`  ✓ Logged in (subscription: ${account})`);
  } catch {
    console.error('  ✗ Not logged in. Run: az login');
    process.exitCode = 1;
    return;
  }

  // ── Step 2: Create / verify resource group ──────────────────────────────
  console.log(`[2/7] Resource group: ${resourceGroup}...`);
  try {
    az(`group show --name "${resourceGroup}" -o none`, { silent: true });
    console.log('  ✓ Already exists');
  } catch {
    console.log('  Creating...');
    az(`group create --name "${resourceGroup}" --location "${location}" -o none`);
    console.log('  ✓ Created');
  }

  // ── Step 3: Create PostgreSQL Flexible Server ───────────────────────────
  console.log(`[3/7] Creating PostgreSQL Flexible Server (this takes 2-5 min)...`);
  try {
    az(
      `postgres flexible-server create` +
        ` --resource-group "${resourceGroup}"` +
        ` --name "${serverName}"` +
        ` --location "${location}"` +
        ` --admin-user "${adminUser}"` +
        ` --admin-password "${adminPassword}"` +
        ` --sku-name "${sku}"` +
        ` --tier Burstable` +
        ` --version 16` +
        ` --storage-size 32` +
        ` --public-access 0.0.0.0` +
        ` --yes` +
        ` -o none`,
      { timeoutMs: 600_000 }, // 10 min — server creation can take a while
    );
    console.log(`  ✓ Server created: ${serverName}.postgres.database.azure.com`);
  } catch (err) {
    // Check if server already exists
    try {
      az(
        `postgres flexible-server show --resource-group "${resourceGroup}" --name "${serverName}" -o none`,
        { silent: true },
      );
      console.log('  ✓ Server already exists');
    } catch {
      console.error(`  ✗ Failed to create server: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  // ── Step 4: Enable pgvector extension ───────────────────────────────────
  console.log('[4/7] Enabling pgvector extension...');
  try {
    // Read current extensions to avoid overwriting
    let currentExtensions = '';
    try {
      currentExtensions = az(
        `postgres flexible-server parameter show` +
          ` --resource-group "${resourceGroup}"` +
          ` --server-name "${serverName}"` +
          ` --name azure.extensions` +
          ` --query value -o tsv`,
        { silent: true },
      );
    } catch {
      // Parameter may not exist yet — that's fine
    }

    if (currentExtensions.includes('VECTOR')) {
      console.log('  ✓ VECTOR already enabled');
    } else {
      const newValue = currentExtensions ? `${currentExtensions},VECTOR` : 'VECTOR';
      az(
        `postgres flexible-server parameter set` +
          ` --resource-group "${resourceGroup}"` +
          ` --server-name "${serverName}"` +
          ` --name azure.extensions` +
          ` --value "${newValue}"` +
          ` -o none`,
      );
      console.log('  ✓ VECTOR extension enabled');
    }
  } catch (err) {
    console.error(`  ✗ Failed to enable pgvector: ${err instanceof Error ? err.message : String(err)}`);
    console.error('  You can enable it manually via Azure Portal → Server parameters → azure.extensions → VECTOR');
  }

  // ── Step 5: Create database ─────────────────────────────────────────────
  console.log(`[5/7] Creating database: ${database}...`);
  try {
    az(
      `postgres flexible-server db create` +
        ` --resource-group "${resourceGroup}"` +
        ` --server-name "${serverName}"` +
        ` --database-name "${database}"` +
        ` -o none`,
    );
    console.log('  ✓ Database created');
  } catch (err) {
    // Check if it already exists (error message varies)
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('already exists')) {
      console.log('  ✓ Database already exists');
    } else {
      console.error(`  ✗ Failed to create database: ${errMsg}`);
      console.error('  You can create it manually: az postgres flexible-server db create ...');
    }
  }

  // ── Step 6: Add firewall rule for current IP ────────────────────────────
  console.log('[6/7] Adding firewall rule for current IP...');
  try {
    // Get current public IP
    let publicIp = '';
    try {
      publicIp = execSync('curl -s https://ifconfig.me', {
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
    } catch {
      try {
        publicIp = execSync('curl -s https://api.ipify.org', {
          encoding: 'utf-8',
          timeout: 10_000,
        }).trim();
      } catch {
        console.log('  ⚠ Could not detect public IP. Add firewall rule manually.');
      }
    }

    if (publicIp && /^\d+\.\d+\.\d+\.\d+$/.test(publicIp)) {
      const ruleName = `dev-${publicIp.replace(/\./g, '-')}`;
      try {
        az(
          `postgres flexible-server firewall-rule create` +
            ` --resource-group "${resourceGroup}"` +
            ` --name "${serverName}"` +
            ` --rule-name "${ruleName}"` +
            ` --start-ip-address "${publicIp}"` +
            ` --end-ip-address "${publicIp}"` +
            ` -o none`,
        );
        console.log(`  ✓ Firewall rule added for ${publicIp}`);
      } catch (fwErr) {
        const fwMsg = fwErr instanceof Error ? fwErr.message : String(fwErr);
        if (fwMsg.includes('already exists') || fwMsg.includes('overlaps')) {
          console.log(`  ✓ Firewall rule already exists for ${publicIp}`);
        } else {
          console.log(`  ⚠ Firewall rule creation failed: ${fwMsg}`);
          console.log(`    Add manually: az postgres flexible-server firewall-rule create --start-ip-address ${publicIp} --end-ip-address ${publicIp} ...`);
        }
      }
    }

    // Also allow Azure services
    try {
      az(
        `postgres flexible-server firewall-rule create` +
          ` --resource-group "${resourceGroup}"` +
          ` --name "${serverName}"` +
          ` --rule-name "AllowAzureServices"` +
          ` --start-ip-address "0.0.0.0"` +
          ` --end-ip-address "0.0.0.0"` +
          ` -o none`,
      );
      console.log('  ✓ Azure services access enabled');
    } catch {
      // May already exist
      console.log('  ✓ Azure services access already configured');
    }
  } catch (err) {
    console.log(`  ⚠ Firewall setup issue: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Step 7: Save DATABASE_URL ───────────────────────────────────────────
  console.log('[7/7] Saving configuration...');
  const databaseUrl =
    `postgres://${adminUser}:${encodeURIComponent(adminPassword)}` +
    `@${serverName}.postgres.database.azure.com:5432/${database}?sslmode=require`;

  setSetting('DATABASE_URL', databaseUrl);
  console.log('  ✓ DATABASE_URL saved to ~/.agent-mem/settings.json');

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('');
  console.log('═'.repeat(48));
  console.log('Provisioning complete!');
  console.log('');
  console.log(`  Host:     ${serverName}.postgres.database.azure.com`);
  console.log(`  Database: ${database}`);
  console.log(`  Admin:    ${adminUser}`);
  console.log(`  Password: ${adminPassword}`);
  console.log('');
  console.log('  DATABASE_URL saved to ~/.agent-mem/settings.json');
  console.log('');
  console.log('  ⚠  Save the admin password — it cannot be recovered from Azure.');
  console.log('');

  // ── Optional: run db push ───────────────────────────────────────────────
  if (runPush) {
    console.log('Running schema push (tables, RLS policies, indexes)...');
    console.log('');
    try {
      const { pushSchema } = await import('../../services/postgres/schema-push.js');
      await pushSchema(databaseUrl);
      console.log('');
      console.log('✓ Schema push complete. You can now start the worker:');
      console.log('  npx tsx src/index.ts start');
    } catch (pushErr) {
      console.error(`Schema push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`);
      console.error('You can run it manually: npx tsx src/index.ts db push');
    }
  } else {
    console.log('Next steps:');
    console.log('  npx tsx src/index.ts db push     # create tables & RLS');
    console.log('  npx tsx src/index.ts start        # start worker daemon');
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

/** Parse --flag and --flag=value from process.argv for the provision command. */
export function parseProvisionArgs(argv: string[]): ProvisionOptions {
  const opts: ProvisionOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    // Support both --flag value and --flag=value
    const getValue = (): string | undefined => {
      if (arg.includes('=')) return arg.split('=').slice(1).join('=');
      if (next && !next.startsWith('--')) {
        i++; // consume next
        return next;
      }
      return undefined;
    };

    if (arg.startsWith('--name')) {
      opts.name = getValue();
    } else if (arg.startsWith('--resource-group') || arg.startsWith('--rg')) {
      opts.resourceGroup = getValue();
    } else if (arg.startsWith('--location') || arg.startsWith('--loc')) {
      opts.location = getValue();
    } else if (arg.startsWith('--admin-user')) {
      opts.adminUser = getValue();
    } else if (arg.startsWith('--admin-password')) {
      opts.adminPassword = getValue();
    } else if (arg.startsWith('--sku')) {
      opts.sku = getValue();
    } else if (arg.startsWith('--database') || arg.startsWith('--db')) {
      opts.database = getValue();
    } else if (arg === '--no-push') {
      opts.pushSchema = false;
    }
  }

  return opts;
}
