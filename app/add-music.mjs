// Lays one music track under a finished movie, so the music carries across every cut.
// The movie's own sound stays on top; the song loops if it is shorter than the movie and
// fades in and out. The movie itself is never changed: a new "- with music" copy is saved.
// Usage: node add-music.mjs <movie> <song> [music volume, 0.05 to 1, default 0.35]
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ffmpeg = path.join(root, 'runtime/ffmpeg/ffmpeg.exe'), ffprobe = path.join(root, 'runtime/ffmpeg/ffprobe.exe');
const videoTypes = /\.(mp4|mov|mkv|webm|m4v)$/i, audioTypes = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i;

const files = process.argv.slice(2).filter(a => fs.existsSync(a));
const movie = files.find(f => videoTypes.test(f)), song = files.find(f => audioTypes.test(f) || (videoTypes.test(f) && f !== movie));
const volume = Math.min(1, Math.max(0.05, Number(process.argv.slice(2).find(a => /^\d*\.?\d+$/.test(a))) || 0.35));
if (!movie || !song) {
  console.log('Drag a finished movie and a song (mp3, wav, m4a...) onto "Add music to a movie.cmd" together.');
  process.exit(1);
}

const probe = file => JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {encoding: 'utf8'}).stdout || '{}');
const info = probe(movie), seconds = Number(info.format?.duration);
if (!seconds) { console.log('Could not read the movie: ' + movie); process.exit(1); }
const movieHasSound = (info.streams || []).some(s => s.codec_type === 'audio');

const base = movie.replace(/\.[^.]+$/, '') + ' - with music';
let output = base + '.mp4';
for (let n = 2; fs.existsSync(output); n++) output = `${base} (${n}).mp4`;

const fadeOut = Math.max(0, seconds - 3).toFixed(2);
const music = `[1:a]volume=${volume},afade=t=in:d=2,afade=t=out:st=${fadeOut}:d=3`;
const filter = movieHasSound ? `${music}[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]` : `${music},atrim=end=${seconds}[a]`;
console.log(`Adding ${path.basename(song)} under ${path.basename(movie)} at ${Math.round(volume * 100)}% volume...`);
const result = spawnSync(ffmpeg, ['-nostdin', '-y', '-i', movie, '-stream_loop', '-1', '-i', song, '-filter_complex', filter,
  '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(seconds), '-movflags', '+faststart', output], {stdio: 'inherit'});
if (result.status !== 0) { console.log('Adding the music failed. The movie was not changed.'); process.exit(1); }
console.log('Saved: ' + output);
