import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * Reads all `.json` files from the given directory,
 * parses each one, and returns an array of their contents.
 *
 * @param {string} dirPath - Path to the directory to scan.
 * @returns {Promise<unknown[]>} Parsed contents of every `.json` file found.
 */
export async function readJsonFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });

  const jsonFiles = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => join(dirPath, entry.name));

  const results = await Promise.all(
    jsonFiles.map(async filePath => {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    })
  );

  return results;
}
