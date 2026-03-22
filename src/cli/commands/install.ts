/**
 * CLI commands: install / uninstall
 *
 * Registers/removes the plugin for Claude Code.
 * Copies the plugin/ directory to ~/.claude/plugins/agent-mem/
 */

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../shared/logger.js';

const log = logger.child('Installer');

/**
 * Resolve the plugin source directory.
 * When running from source: ./plugin/
 * When installed globally: <package-root>/plugin/
 */
function findPluginDir(): string {
  // Check relative to this file (dist/cli/commands/)
  const fromDist = join(import.meta.dirname || __dirname, '..', '..', '..', 'plugin');
  if (existsSync(fromDist)) return fromDist;

  // Check relative to cwd
  const fromCwd = join(process.cwd(), 'plugin');
  if (existsSync(fromCwd)) return fromCwd;

  throw new Error('Cannot find plugin/ directory. Run from the project root or install globally.');
}

/**
 * Get Claude Code plugins directory
 */
function getClaudePluginsDir(): string {
  return join(homedir(), '.claude', 'plugins');
}

export async function install(): Promise<void> {
  const pluginSrc = findPluginDir();
  const pluginDest = join(getClaudePluginsDir(), 'agent-mem');

  log.info('Installing plugin', { from: pluginSrc, to: pluginDest });

  // Create parent directory
  mkdirSync(join(getClaudePluginsDir()), { recursive: true });

  // Remove old installation if exists
  if (existsSync(pluginDest)) {
    rmSync(pluginDest, { recursive: true, force: true });
    log.info('Removed previous installation');
  }

  // Copy plugin directory
  cpSync(pluginSrc, pluginDest, { recursive: true });

  console.log(`Plugin installed to ${pluginDest}`);
  console.log('Restart Claude Code to activate. Hooks and MCP tools will be available automatically.');
}

export async function uninstall(): Promise<void> {
  const pluginDest = join(getClaudePluginsDir(), 'agent-mem');

  if (!existsSync(pluginDest)) {
    console.log('Plugin is not installed.');
    return;
  }

  rmSync(pluginDest, { recursive: true, force: true });
  console.log('Plugin uninstalled. Your data in ~/.agent-mem/ and database tables are preserved.');
}
