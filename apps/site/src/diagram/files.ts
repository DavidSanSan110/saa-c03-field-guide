// Diagram files loader and folder check (spec 013). Pure Node, no Astro imports; runs at build and in tests.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { prepareDiagram } from './prepare.ts';

/** Max caption length for diagram files (the schema allows 300; files keep captions short for narrow screens). */
export const MAX_FILE_CAPTION_LENGTH = 140;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FILE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*\.yaml$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads and parses `<dir>/<id>.yaml`; throws an Error whose message names the problem. */
export function readDiagramFile(dir: string, id: string): unknown {
  if (!SLUG.test(id)) throw new Error(`Diagram id '${id}' is not a lowercase slug`);
  const name = `${id}.yaml`;

  let text: string;
  try {
    text = readFileSync(join(dir, name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Diagram file '${name}' not found in ${dir}`, { cause: error });
    }
    throw new Error(`Diagram file '${name}' cannot be read: ${messageOf(error)}`, { cause: error });
  }

  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new Error(`Diagram file '${name}' is not valid YAML: ${messageOf(error)}`, {
      cause: error,
    });
  }

  const fileId =
    typeof data === 'object' && data !== null ? (data as { id?: unknown }).id : undefined;
  if (typeof fileId === 'string' && fileId !== id) {
    throw new Error(`'${name}' has id '${fileId}'; the file name must match the id`);
  }
  return data;
}

/** The problems of one `<slug>.yaml` file, without the file-name prefix. */
async function checkFile(
  dir: string,
  name: string,
  opts: { iconExists: (publicPath: string) => boolean },
): Promise<string[]> {
  try {
    const data = readDiagramFile(dir, name.slice(0, -'.yaml'.length));
    const { props } = await prepareDiagram(data, opts);
    const problems: string[] = [];
    for (const scenario of props.wide.diagram.scenarios) {
      scenario.steps.forEach((step, index) => {
        if (step.caption.length > MAX_FILE_CAPTION_LENGTH) {
          problems.push(
            `scenario '${scenario.id}' step ${index + 1}: caption has ${step.caption.length} characters (max ${MAX_FILE_CAPTION_LENGTH})`,
          );
        }
      });
    }
    return problems;
  } catch (error) {
    return [messageOf(error)];
  }
}

/** Every problem in a diagrams folder, as human-readable lines; [] when all is well. */
export async function checkDiagramFiles(
  dir: string,
  opts: { iconExists: (publicPath: string) => boolean },
): Promise<string[]> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return [`Diagrams folder '${dir}' cannot be read: ${messageOf(error)}`];
  }

  const problems: string[] = [];
  const sorted = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    if (!entry.isFile() || !FILE_NAME.test(entry.name)) {
      problems.push(`${entry.name}: only <id>.yaml files belong in diagrams/`);
      continue;
    }
    for (const problem of await checkFile(dir, entry.name, opts)) {
      problems.push(`${entry.name}: ${problem}`);
    }
  }
  return problems;
}
