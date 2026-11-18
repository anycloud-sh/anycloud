import { getCatalogs } from '../src/shared/catalog';
import BetterSqlite3 from 'better-sqlite3';
import { createDatabase } from '../src/api/services/repositories/db';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TestProject } from 'vitest/node';

export async function setup(project: TestProject) {
  // Catalogs download into a scratch ANYCLOUD_DIR kept between runs, never the
  // developer's home; test/unit/setup.ts links them into each test's home.
  const catalogsHome = join(tmpdir(), 'anycloud-unit-catalogs');
  const previousAnycloudDir = process.env.ANYCLOUD_DIR;
  process.env.ANYCLOUD_DIR = catalogsHome;
  try {
    await getCatalogs();
  } finally {
    if (previousAnycloudDir === undefined) delete process.env.ANYCLOUD_DIR;
    else process.env.ANYCLOUD_DIR = previousAnycloudDir;
  }
  project.provide('testCatalogsPath', join(catalogsHome, 'catalogs'));

  const templateDir = mkdtempSync(join(tmpdir(), 'anycloud-test-db-template-'));
  const templatePath = join(templateDir, 'template.db');
  const previousSqlitePath = process.env.SQLITE_PATH;
  const previousIsTest = process.env.IS_TEST;

  try {
    process.env.SQLITE_PATH = templatePath;
    process.env.IS_TEST = 'true';
    const db = createDatabase();
    await db.init?.();
    db.close();
    // Tests deserialize the template into memory, where no WAL file exists.
    const template = new BetterSqlite3(templatePath);
    template.pragma('journal_mode = DELETE');
    template.close();
  } catch (error) {
    rmSync(templateDir, { recursive: true, force: true });
    throw error;
  } finally {
    if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = previousSqlitePath;
    if (previousIsTest === undefined) delete process.env.IS_TEST;
    else process.env.IS_TEST = previousIsTest;
  }

  project.provide('testDatabaseTemplatePath', templatePath);
  return () => rmSync(templateDir, { recursive: true, force: true });
}
