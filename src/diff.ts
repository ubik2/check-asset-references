import { parse } from 'csv-parse/sync';
import { spawn } from 'child_process';
import { Stream } from 'stream';
import path from 'path';
import fs from 'fs';
import parseDiff from 'parse-diff';

// git diff 5f92d0ba63f6031189e16c87d591a9500701b523...2f3be3b6145ab7099db73e727bf4b02696292f66
// git show 5f92d0ba63f6031189e16c87d591a9500701b523:activities.csv
// use child-process to exec git commands
// https://github.com/sergeyt/parse-diff
// write markdown report to $GITHUB_STEP_SUMMARY

type Row = { [id: string]: string };
type Table = Row[];

interface TableDiff {
  added: { [id: string]: Row };
  removed: { [id: string]: Row };
  modified: { [id: string]: [Row, Row] };
}

async function streamToBuffer(stream: Stream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = Array<any>();
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (err) => reject(`Error reading stream: ${err}`));
  });
}

function setSubtract<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set<T>([...a].filter((item) => !b.has(item)));
}

function setUnion<T>(a: Set<T>, b: Set<T>): Set<T> {
  const tmp = new Set<T>(a);
  [...b].forEach((item) => tmp.add(item));
  return tmp;
}

function setIntersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set<T>([...a].filter((item) => b.has(item)));
}

async function generateDiff(
  workspace: string,
  gitBaseSha: string,
  gitHeadSha: string,
): Promise<parseDiff.File[]> {
  const childProcess = spawn('git', ['diff', `${gitBaseSha}...${gitHeadSha}`], { cwd: workspace });
  const fileContents = await streamToBuffer(childProcess.stdout);
  const files = parseDiff(fileContents.toString());
  console.log(files);
  return files;
}

async function loadActivities(
  workspace: string,
  csvPlatformPath: string,
  gitSha?: string,
): Promise<Table> {
  let fileContents;
  if (typeof gitSha !== 'undefined') {
    const childProcess = spawn('git', ['show', `${gitSha}:${csvPlatformPath}`], { cwd: workspace });
    fileContents = await streamToBuffer(childProcess.stdout);
  } else {
    const absoluteCsvPath = path.join(workspace, csvPlatformPath);
    fileContents = fs.readFileSync(absoluteCsvPath, 'utf-8');
  }
  const records: Table = parse(fileContents, {
    columns: true,
    skip_empty_lines: true,
  });
  return records;
}

// For now, we don't do anything for newly introduced or removed columns
function getModifiedColumns(a: Row, b: Row): string[] {
  const columns = setUnion(new Set(Object.keys(a)), new Set(Object.keys(b)));
  return [...columns].filter((column) =>
    column in a && column in b ? a[column] != b[column] : false,
  );
}

function generateActivityDiff(a: Table, b: Table): string {
  const chunks: string[] = [];
  const result = getActivityChanges(a, b);
  if (Object.keys(result.added).length > 0) {
    chunks.push('### New activities\n');
    for (const [uuid, row] of Object.entries(result.added)) {
      const title = 'Title' in row ? row['Title'] : 'missing title';
      chunks.push(` - [${title}](# ${uuid})\n`);
    }
  }
  if (Object.keys(result.removed).length > 0) {
    chunks.push('### Removed activities\n');
    for (const [uuid, row] of Object.entries(result.removed)) {
      const title = 'Title' in row ? row['Title'] : 'missing title';
      chunks.push(` - [${title}](# ${uuid})\n`);
    }
  }
  if (Object.keys(result.modified).length > 0) {
    chunks.push('### Modified activities\n');
    for (const [uuid, [rowA, rowB]] of Object.entries(result.modified)) {
      const title = 'Title' in rowB ? rowB['Title'] : 'missing title';
      chunks.push(` - [${title}](# ${uuid})\n`);
      // TODO: Also add check for changed json or changed video
      for (const column in getModifiedColumns(rowA, rowB)) {
        const aValue = column in rowA ? '(null)' : rowA[column];
        const bValue = column in rowB ? '(null)' : rowB[column];
        chunks.push(`   - **${column}** changed from "${aValue}" to "${bValue}"\n`);
      }
    }
  }
  return chunks.join();
}

function getActivityChanges(a: Table, b: Table): TableDiff {
  const aDict: { [id: string]: Row } = {};
  a.forEach((row) => {
    if ('UUID' in row) {
      aDict[row['UUID']] = row;
    }
  });
  const bDict: { [id: string]: Row } = {};
  b.forEach((row) => {
    if ('UUID' in row) {
      bDict[row['UUID']] = row;
    }
  });
  const aKeys = new Set<string>(Object.keys(a));
  const bKeys = new Set<string>(Object.keys(b));
  const added: { [uuid: string]: Row } = {};
  setSubtract(bKeys, aKeys).forEach((key) => (added[key] = bDict[key]));
  const removed: { [uuid: string]: Row } = {};
  setSubtract(aKeys, bKeys).forEach((key) => (removed[key] = aDict[key]));
  const modified: { [uuid: string]: [Row, Row] } = {};
  [...setIntersection(aKeys, bKeys)]
    .filter((key) => getModifiedColumns(aDict[key], bDict[key]).length > 0)
    .forEach((key) => (modified[key] = [aDict[key], bDict[key]]));
  return { added: added, removed: removed, modified: modified };
}

export { generateDiff, loadActivities, generateActivityDiff, Table };
