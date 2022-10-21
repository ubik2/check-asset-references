import * as core from '@actions/core';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import * as glob from '@actions/glob';

function logGroup(files: Set<string>, message: string, isError: boolean) {
  if (files.size > 0) {
    core.startGroup(message);
    for (const filename of files) {
      isError ? core.error(filename) : core.warning(filename);
    }
    core.endGroup();
  }
}

function getReferencedTaskFiles(csvFile: string): Set<string> {
  const files = new Set<string>();
  const fileContents = fs.readFileSync(csvFile, 'utf-8');
  const records: { [id: string]: string }[] = parse(fileContents, {
    columns: true,
    skip_empty_lines: true,
  });
  for (let i = 0; i < records.length; i++) {
    const record: { [id: string]: string } = records[i];
    if ('Action Link' in record && record['Action Link']) {
      files.add(record['Action Link']);
    }
  }
  return files;
}

async function getTaskFiles(rootDir: string): Promise<Set<string>> {
  const files = new Set<string>();

  const globber = await glob.create(path.join(rootDir, 'tasks/*.json'));
  const matches = await globber.glob();
  for (const file of matches) {
    files.add(core.toPosixPath(path.relative(rootDir, file)));
  }
  return files;
}

async function getMediaFiles(rootDir: string): Promise<Set<string>> {
  const files = new Set<string>();
  const globber = await glob.create(path.join(rootDir, 'video/*'));
  const matches = await globber.glob();
  for (const file of matches) {
    files.add(core.toPosixPath(path.relative(rootDir, file)));
  }
  return files;
}

function getReferencedMediaFiles(rootDir: string, taskFiles: Set<string>): Set<string> {
  const files = new Set<string>();
  for (const file of taskFiles) {
    const absolutePath = path.join(rootDir, core.toPlatformPath(file));
    const taskInfo = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    for (let i = 0; i < taskInfo['steps'].length; i++) {
      const step = taskInfo['steps'][i];
      if ('videoUrl' in taskInfo['steps'][i]) {
        files.add(decodeURI(step['videoUrl']));
      }
      if ('audioUrl' in taskInfo['steps'][i]) {
        files.add(decodeURI(step['audioUrl']));
      }
    }
  }
  return files;
}

export async function run(): Promise<void> {
  try {
    const githubWorkspace = process.env.GITHUB_WORKSPACE;
    const csvPath = core.getInput('csv', { required: true });
    const magicTasks = core.getInput('magicTasks');
    if (!githubWorkspace) {
      throw new Error(`$GITHUB_WORKSPACE is not set`);
    }
    const absoluteRoot = path.resolve(githubWorkspace);
    const absoluteCsvPath = path.join(absoluteRoot, core.toPlatformPath(csvPath));

    const taskFiles = await getTaskFiles(absoluteRoot);
    const usedTaskFiles = getReferencedTaskFiles(absoluteCsvPath);
    for (const element of magicTasks.split(',')) {
      if (element) {
        usedTaskFiles.add(element);
      }
    }

    const missingTaskFiles = new Set([...usedTaskFiles].filter((i) => !taskFiles.has(i)));
    const unusedTaskFiles = new Set([...taskFiles].filter((i) => !usedTaskFiles.has(i)));
    const taskFilesIntersection = new Set([...usedTaskFiles].filter((i) => taskFiles.has(i)));

    const mediaFiles = await getMediaFiles(absoluteRoot);
    const usedMediaFiles = getReferencedMediaFiles(absoluteRoot, taskFilesIntersection);

    const missingMediaFiles = new Set([...usedMediaFiles].filter((i) => !mediaFiles.has(i)));
    const unusedMediaFiles = new Set([...mediaFiles].filter((i) => !usedMediaFiles.has(i)));

    logGroup(missingTaskFiles, 'Missing task files', true);
    logGroup(unusedTaskFiles, 'Unused task files', false);

    logGroup(missingMediaFiles, 'Missing media files', true);
    logGroup(unusedMediaFiles, 'Unused media files', false);

    if (missingTaskFiles.size > 0 || missingMediaFiles.size > 0) {
      core.setFailed(`ubik2/check-references-action failed with missing files`);
    }
  } catch (err) {
    core.setFailed(`ubik2/check-references-action failed with: ${err}`);
  }
}

// Execute this as the entrypoint when requested.
if (require.main === module) {
  run();
}
