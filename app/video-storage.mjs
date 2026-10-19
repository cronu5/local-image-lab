import fs from 'node:fs';
import path from 'node:path';

const idPattern = /^[A-Za-z0-9-]+$/;
const outputPattern = /^(?:videos\/[A-Za-z0-9-]+\/)?[A-Za-z0-9-]+\.(mp4|jpg|json)$/;
export function outputFile(root, name) {
  if (typeof name !== 'string' || !outputPattern.test(name)) throw Object.assign(Error('Invalid video filename.'), {status:400});
  const base = path.resolve(root, 'outputs'), file = path.resolve(base, name);
  if (!file.startsWith(base + path.sep)) throw Object.assign(Error('Invalid video path.'), {status:400});
  return file;
}
export function sessionFolder(root, id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw Object.assign(Error('Invalid run.'), {status:400});
  return path.join(root, 'outputs', 'videos', id);
}
export function atomicJson(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
export function publicVideo(meta) {
  return {...meta, url:'/api/video/file?name=' + encodeURIComponent(meta.filename), poster:'/api/video/file?name=' + encodeURIComponent(meta.poster), metadataUrl:'/api/video/file?name=' + encodeURIComponent(meta.filename.replace(/\.mp4$/, '.json'))};
}
export function saveVideo(root, meta) {
  atomicJson(outputFile(root, meta.filename.replace(/\.mp4$/, '.json')), meta);
  return publicVideo(meta);
}
export function saveSession(root, session) {
  const dir = sessionFolder(root, session.id); fs.mkdirSync(dir, {recursive:true});
  atomicJson(path.join(dir, 'session.json'), session);
}
export function readSession(root, id) {
  const file = path.join(sessionFolder(root, id), 'session.json');
  if (!fs.existsSync(file)) throw Object.assign(Error('This run could not be found.'), {status:404});
  const session = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (session.id !== id || !Array.isArray(session.clips)) throw Error('Invalid run record.');
  return session;
}
export function listSessions(root, activeId) {
  const base = path.join(root, 'outputs', 'videos'); if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, {withFileTypes:true}).filter(e => e.isDirectory() && idPattern.test(e.name)).sort((a,b) => b.name.localeCompare(a.name)).flatMap(e => {
    try {
      const s = readSession(root, e.name), active = activeId === s.id;
      const available = s.clips.filter(c => fs.existsSync(outputFile(root, c.filename)));
      const result = s.result && fs.existsSync(outputFile(root, s.result.filename)) ? publicVideo(s.result) : null;
      return [{id:s.id, name:s.name, createdAt:s.createdAt, status:!active && ['running','merging'].includes(s.status) ? 'interrupted' : s.status, active, clipCount:available.length, seconds:available.reduce((n,c) => n+c.frames, 0)/24 - Math.max(0,available.length-1)*(s.overlapFrames||0)/24, storySummary:s.storyMemory?.facts?.summary, reviewedThroughClip:s.storyMemory?.lastReviewedClipIndex, latestPlan:s.latestPlan, elapsedMs:s.elapsedMs||0, stopReason:s.stopReason, message:s.message, result, latestClip:available.length ? publicVideo(available.at(-1)) : null, clips:available.map(publicVideo)}];
    } catch { return []; }
  }).slice(0,100);
}

// Only disposable files under this run's inputs directory may be removed.
export function removeWork(dir, target) {
  const base = path.resolve(dir), resolved = path.resolve(target);
  if (!resolved.startsWith(base + path.sep)) throw Error('Refusing to remove a file outside this run.');
  fs.rmSync(resolved, {recursive:true, force:true});
}
