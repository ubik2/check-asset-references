import { parse } from 'csv-parse/sync';
import { spawn } from 'child_process';
import { Stream } from 'stream';
import path from 'path';
import fs from 'fs';
import parseDiff from 'parse-diff';
import { setSubtract, setUnion, setIntersection } from './set';

type Row = { [id: string]: string };
type Table = Row[];
type TaskTable = { [id: string]: Row };

interface TableDiff {
  added: { [id: string]: Row };
  removed: { [id: string]: Row };
  modified: { [id: string]: [Row, Row] };
}

const markdownReplacements: [RegExp, string][] = [
  [/\//g, '\\/'],
  [/`/g, '\\`'],
  [/\*/g, '\\*'],
  [/_/g, '\\_'],
  [/\{/g, '\\{'],
  [/\}/g, '\\}'],
  [/\[/g, '\\['],
  [/\]/g, '\\]'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/\(/g, '\\('],
  [/\)/g, '\\)'],
  [/#/g, '\\#'],
  [/\+/g, '\\+'],
  [/-/g, '\\-'],
  [/\./g, '\\.'],
  [/!/g, '\\!'],
  [/\|/g, '\\|'],
];

function markdownEscape(text: string): string {
  return markdownReplacements.reduce((str, pair) => str.replace(pair[0], pair[1]), text);
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

async function generateDiff(
  workspace: string,
  gitBaseSha: string,
  gitHeadSha: string,
): Promise<parseDiff.File[]> {
  const childProcess = spawn('git', ['diff', `${gitBaseSha}...${gitHeadSha}`], { cwd: workspace });
  const fileContents = await streamToBuffer(childProcess.stdout);
  const files = parseDiff(fileContents.toString());
  return files;
}

async function loadActivities(
  workspace: string,
  csvPlatformPath: string,
  gitSha?: string,
): Promise<Table> {
  if (typeof gitSha !== 'undefined') {
    const childProcess = spawn('git', ['show', `${gitSha}:${csvPlatformPath}`], { cwd: workspace });
    const fileContents = await streamToBuffer(childProcess.stdout);
    const records: Table = parse(fileContents, {
      columns: true,
      skip_empty_lines: true,
    });
    return records;
  } else {
    return await loadCsv(workspace, csvPlatformPath);
  }
}

async function loadCsv(workspace: string, csvPlatformPath: string): Promise<Table> {
  const absoluteCsvPath = path.join(workspace, csvPlatformPath);
  const fileContents = fs.readFileSync(absoluteCsvPath, 'utf-8');
  const records: Table = parse(fileContents, {
    columns: true,
    skip_empty_lines: true,
  });
  return records;
}

// For now, we don't do anything for newly introduced or removed columns
// We also need to ignore newline changes, since git show and file access may use different conventions
function getModifiedColumns(a: Row, b: Row): string[] {
  const columns = setUnion(new Set(Object.keys(a)), new Set(Object.keys(b)));
  const modifiedColumns = [...columns].filter(
    (column) =>
      column in a &&
      column in b &&
      a[column] !== b[column] &&
      a[column].replace(/\r\n/g, '\n') !== b[column].replace(/\r\n/g, '\n'),
  );
  return modifiedColumns;
}

function getEscapedTitle(row: Row): string {
  return 'Title' in row && row['Title'] !== '' ? markdownEscape(row['Title']) : 'missing title';
}

async function generateActivityDiff(
  a: Table,
  b: Table,
  usedMediaFileReferences: { [taskFile: string]: Set<string> },
  absoluteRoot: string,
  gitBaseSha: string,
  gitHeadSha: string,
): Promise<string> {
  let parsedDiffResult: parseDiff.File[] | undefined;
  if (gitBaseSha && gitHeadSha) {
    parsedDiffResult = await generateDiff(absoluteRoot, gitBaseSha, gitHeadSha);
  }
  const chunks: string[] = [];
  const taskTableA = getTaskTable(a);
  const taskTableB = getTaskTable(b);
  const result = getActivityChanges(
    taskTableA,
    taskTableB,
    usedMediaFileReferences,
    parsedDiffResult,
  );
  const tooltips: string[] = [];
  if (Object.keys(result.added).length > 0) {
    chunks.push('### New activities\n');
    for (const [uuid, row] of Object.entries(result.added)) {
      tooltips.push(`[${uuid}]: ## "${uuid}"\n`);
      chunks.push(` - [${getEscapedTitle(row)}][${uuid}]${getLogicFlagsString(row)}\n`);
    }
  }
  if (Object.keys(result.removed).length > 0) {
    chunks.push('### Removed activities\n');
    for (const [uuid, row] of Object.entries(result.removed)) {
      tooltips.push(`[${uuid}]: ## "${uuid}"\n`);
      chunks.push(` - [${getEscapedTitle(row)}][${uuid}]${getLogicFlagsString(row)}\n`);
    }
  }
  if (Object.keys(result.modified).length > 0) {
    chunks.push('### Modified activities\n');
    for (const [uuid, [rowA, rowB]] of Object.entries(result.modified)) {
      tooltips.push(`[${uuid}]: ## "${uuid}"\n`);
      chunks.push(` - [${getEscapedTitle(rowB)}][${uuid}]${getLogicFlagsString(rowA, rowB)}\n`);
      const taskFile =
        'Action Link' in taskTableB[uuid] ? taskTableB[uuid]['Action Link'] : undefined;
      getModifiedColumns(rowA, rowB).forEach((column) => {
        const aValue = column in rowA ? markdownEscape(rowA[column]) : '(null)';
        const bValue = column in rowB ? markdownEscape(rowB[column]) : '(null)';
        if (aValue.length < 40 && bValue.length < 40) {
          chunks.push(`   - **${column}** changed from "${aValue}" to "${bValue}"\n`);
        } else {
          chunks.push(`   - **${column}** changed\n`);
        }
      });
      if (taskFile && parsedDiffResult) {
        const diffResult = parsedDiffResult;
        if (hasModifiedFile(taskFile, diffResult)) {
          chunks.push(`   - **Task ${taskFile}** changed\n`);
        }
        if (taskFile in usedMediaFileReferences) {
          [...usedMediaFileReferences[taskFile]].forEach((mediaFile) => {
            if (hasModifiedFile(mediaFile, diffResult)) {
              chunks.push(`   - **Media ${mediaFile}** changed\n`);
            }
          });
        }
      }
    }
  }
  return [tooltips.join(''), chunks.join('')].join('');
}

function hasModifiedColumns(rowA: Row, rowB: Row) {
  return getModifiedColumns(rowA, rowB).length > 0;
}

function hasModifiedFile(filename: string, parsedDiffResult: parseDiff.File[]) {
  return (
    parsedDiffResult.findIndex((entry) => entry.from === filename || entry.to == filename) != -1
  );
}

function hasModifiedFileInSet(mediaFiles: Set<string>, parsedDiffResult: parseDiff.File[]) {
  return (
    parsedDiffResult.findIndex(
      (entry) =>
        (entry.from && mediaFiles.has(entry.from)) || (entry.to && mediaFiles.has(entry.to)),
    ) != -1
  );
}

function getTaskTable(table: Table): TaskTable {
  const taskTable: TaskTable = {};
  table.forEach((row) => {
    if ('UUID' in row && row['UUID'] !== '') {
      taskTable[row['UUID']] = row;
    }
  });
  return taskTable;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isDevCheck(obj: { [key: string]: any }) {
  const serverEnvVar1 = JSON.stringify({ '==': ['dev', { var: 'server.env' }] });
  const serverEnvVar2 = JSON.stringify({ '==': [{ var: 'server.env' }, 'dev'] });
  const objStr = JSON.stringify(obj);
  return objStr === serverEnvVar1 || objStr === serverEnvVar2;
}

function getLogicFlags(row: Row): string | null {
  if ('JsonLogic' in row) {
    const jsonLogic = row['JsonLogic'];
    if (jsonLogic.trim() === '') {
      return null;
    }
    try {
      const jsonLogicObj = JSON.parse(jsonLogic);
      console.log(jsonLogicObj);
      if (!jsonLogicObj) {
        return 'disabled';
      }
      if (isDevCheck(jsonLogicObj)) {
        return 'dev only';
      }
      // Check to see if we have an "and" check that contains a top level dev check
      if ('and' in jsonLogicObj) {
        const args = jsonLogicObj['and'];
        if (Array.isArray(args)) {
          if (args.reduce((status, obj) => status == status || isDevCheck(obj), false)) {
            return 'dev only';
          }
        }
        return null;
      }
    } catch (e) {
      // Invalid jsonlogic is another problem, but we don't deal with it here
    }
  }
  return null;
}

function getLogicFlagsString(row: Row, newRow?: Row): string {
  if (newRow) {
    const logicStatusA = getLogicFlags(row);
    const logicStatusB = getLogicFlags(newRow);
    if (logicStatusA === logicStatusB) {
      return logicStatusB != null ? ` (${logicStatusB})` : '';
    } else if (logicStatusA == null) {
      return ` (changed to ${logicStatusB})`;
    } else if (logicStatusB == null) {
      return ` (changed from ${logicStatusA})`;
    } else {
      return ` (changed from ${logicStatusA} to ${logicStatusB})`;
    }
  } else {
    const logicStatus = getLogicFlags(row);
    return logicStatus != null ? ` (${logicStatus})` : '';
  }
}

function getActivityChanges(
  aDict: TaskTable,
  bDict: TaskTable,
  usedMediaFileReferences: { [taskFile: string]: Set<string> },
  parsedDiffResult: parseDiff.File[] | undefined,
): TableDiff {
  const aKeys = new Set<string>(Object.keys(aDict));
  const bKeys = new Set<string>(Object.keys(bDict));
  const added: { [uuid: string]: Row } = {};
  setSubtract(bKeys, aKeys).forEach((key) => (added[key] = bDict[key]));
  const removed: { [uuid: string]: Row } = {};
  setSubtract(aKeys, bKeys).forEach((key) => (removed[key] = aDict[key]));
  const modified: { [uuid: string]: [Row, Row] } = {};
  [...setIntersection(aKeys, bKeys)]
    .filter((key) => {
      if (hasModifiedColumns(aDict[key], bDict[key])) {
        return true;
      }
      const taskFile = 'Action Link' in bDict[key] ? bDict[key]['Action Link'] : undefined;
      if (!taskFile || !parsedDiffResult) {
        return false;
      }
      return (
        hasModifiedFile(taskFile, parsedDiffResult) ||
        hasModifiedFileInSet(usedMediaFileReferences[taskFile], parsedDiffResult)
      );
    })
    .forEach((key) => {
      modified[key] = [aDict[key], bDict[key]];
    });
  return { added: added, removed: removed, modified: modified };
}

export { generateDiff, loadActivities, loadCsv, generateActivityDiff, Table };
