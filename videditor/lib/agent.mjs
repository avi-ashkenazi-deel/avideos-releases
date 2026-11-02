// Drives Claude Code (`claude -p … --output-format stream-json`) inside a
// project folder and streams what it does back to the Studio chat. No API
// key: it runs on the user's own Claude Code install and subscription.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SKILL = fs.readFileSync(path.join(ROOT, 'skills', 'videditor', 'SKILL.md'), 'utf8');

export function systemPrompt({ dir, composition, files, assetsDir = null }) {
  let media = ''; try { media = fs.readFileSync(path.join(dir, 'MEDIA.md'), 'utf8'); if (media.length > 12000) media = media.slice(0, 12000) + '\n…(truncated; open MEDIA.md for the rest)'; } catch {}
  let brand = ''; try { brand = fs.readFileSync(path.join(dir, 'brand.json'), 'utf8'); } catch {}
  const clips = (composition?.clips || []).slice(0, 60).map((c) => `  ${c.id ? '#' + c.id : '<' + c.tag + '>'} start=${c.start} dur=${c.duration ?? 'auto'} track=${c.track ?? 0}${c.text ? ` "${c.text}"` : ''}${c.src ? ` src=${c.src}` : ''}`).join('\n');
  return [
    'You are the video editor agent inside Videditor. The project folder is the current working directory. Work only inside it.',
    '',
    SKILL,
    '',
    `## This project`,
    `Folder: ${dir}`,
    composition ? `Composition "${composition.id}": ${composition.width}×${composition.height}, ${composition.duration ?? '?'}s, ${composition.fps || 30} fps, ${composition.clips.length} clips:\n${clips}` : 'No composition parsed yet.',
    files?.length ? `Files: ${files.slice(0, 80).map((f) => f.path).join(', ')}` : '',
    assetsDir ? `Linked asset folder (use as library/<name> in src): ${assetsDir}` : '',
    brand ? `\n## Brand (brand.json → brand.css variables)\n${brand}` : '',
    media ? `\n## Media analysis (from MEDIA.md)\n${media}` : '',
    '',
    'When you finish, reply with a short summary of what changed (clip ids, seconds) and anything you want the person to check. Do not run a render; Videditor renders.',
  ].join('\n');
}

const ALLOWED = 'Read,Edit,Write,MultiEdit,Glob,Grep,LS,WebFetch,Bash(ls:*),Bash(cat:*),Bash(ffprobe:*),Bash(ffmpeg:*),Bash(curl:*),Bash(mkdir:*),Bash(cp:*),Bash(mv:*),Bash(python3:*),Bash(node:*)';

/**
 * runClaude({ dir, prompt, system, sessionId, onEvent }) → { sessionId, result, cost }
 * onEvent receives { type: 'text'|'tool'|'tool_result'|'status'|'done'|'error', ... }
 */
export function runClaude({ dir, prompt, system, sessionId, model, onEvent, idleMs = 4 * 60 * 1000, maxMs = 25 * 60 * 1000 }) {
  let killer = null;
  const promise = new Promise((resolve) => {
    const bin = process.env.VIDEDITOR_CLAUDE_BIN || 'claude';
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED, '--append-system-prompt', system];
    if (sessionId) args.push('--resume', sessionId);
    if (model) args.push('--model', model);
    const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    let child;
    try { child = spawn(bin, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { onEvent?.({ type: 'error', message: e.message }); return resolve({ error: e.message }); }
    const out = { sessionId: sessionId || null, result: '', cost: null, error: null };
    let buf = ''; let stderr = ''; let rawOut = '';
    // Watchdog: a run that prints nothing for idleMs, or runs longer than maxMs, is stopped so the chat never hangs.
    let idleTimer = null; const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { out.error = `Claude Code produced no output for ${Math.round(idleMs / 60000)} minutes and was stopped. Run diagnostics to see what it does on this computer.`; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, idleMs); };
    const maxTimer = setTimeout(() => { out.error = `Claude Code ran for more than ${Math.round(maxMs / 60000)} minutes and was stopped.`; child.kill('SIGTERM'); }, maxMs);
    armIdle();
    killer = (reason) => { out.error = reason || 'Stopped by you.'; child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref(); };
    const handle = (msg) => {
      if (msg.type === 'system' && msg.subtype === 'init') { out.sessionId = msg.session_id; onEvent?.({ type: 'status', message: `Claude Code ${msg.model || ''} started`, sessionId: msg.session_id }); }
      else if (msg.type === 'assistant') {
        for (const b of msg.message?.content || []) {
          if (b.type === 'text' && b.text) onEvent?.({ type: 'text', text: b.text });
          if (b.type === 'tool_use') onEvent?.({ type: 'tool', name: b.name, detail: describeTool(b, dir) });
        }
      } else if (msg.type === 'user') {
        for (const b of msg.message?.content || []) if (b.type === 'tool_result' && b.is_error) onEvent?.({ type: 'tool_result', error: true, text: String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 300) });
      } else if (msg.type === 'result') {
        out.result = msg.result || ''; out.cost = msg.total_cost_usd ?? null;
        if (msg.is_error) out.error = msg.result || msg.subtype || 'error';
      }
    };
    child.stdout.on('data', (d) => { armIdle(); buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { handle(JSON.parse(line)); } catch { rawOut += line + '\n'; if (rawOut.length > 4000) rawOut = rawOut.slice(-4000); } } });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on('error', (e) => { const msg = e.code === 'ENOENT' ? `Claude Code was not found (looked for "${bin}"). Install it: npm install -g @anthropic-ai/claude-code, or set VIDEDITOR_CLAUDE_BIN.` : e.message; onEvent?.({ type: 'error', message: msg }); resolve({ ...out, error: msg }); });
    child.on('close', (code) => {
      clearTimeout(idleTimer); clearTimeout(maxTimer);
      if (buf.trim()) { try { handle(JSON.parse(buf.trim())); } catch { rawOut += buf; } }
      if (code === null && !out.error) out.error = `Claude Code was terminated (${arguments[1] || 'signal'}).`;
      if (code !== 0 && code !== null && !out.error) {
        const detail = [stderr.trim(), rawOut.trim()].filter(Boolean).join('\n');
        out.error = `Claude Code exited with code ${code}${detail ? ':\n' + detail.split('\n').slice(-12).join('\n') : ' and printed nothing. Try running this in a terminal inside the project folder to see why:\n' + bin + ' -p "hello" --output-format stream-json --verbose'}`;
      }
      if (out.error && (stderr.trim() || rawOut.trim()) && !out.error.includes(stderr.trim().split('\n').slice(-1)[0] || '\u0000')) out.error += '\n' + [stderr.trim(), rawOut.trim()].filter(Boolean).join('\n').split('\n').slice(-8).join('\n');
      if (out.error) onEvent?.({ type: 'error', message: out.error });
      onEvent?.({ type: 'done', result: out.result, cost: out.cost, sessionId: out.sessionId });
      resolve(out);
    });
  });
  promise.kill = (reason) => killer?.(reason);
  return promise;
}

function describeTool(b, dir) {
  const i = b.input || {};
  const rel = (p) => (p ? path.relative(dir, p) || p : '');
  switch (b.name) {
    case 'Edit': case 'MultiEdit': case 'Write': case 'Read': return rel(i.file_path);
    case 'Bash': return (i.command || '').slice(0, 80);
    case 'Glob': case 'Grep': return i.pattern || '';
    case 'WebFetch': return i.url || '';
    default: return '';
  }
}

/** Run a tiny smoke test of the local Claude Code install and return what it printed. */
export function diagnoseClaude(dir) {
  const bin = process.env.VIDEDITOR_CLAUDE_BIN || 'claude';
  const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  const run = (args, timeout) => { const r = spawnSync(bin, args, { cwd: dir, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }); return { code: r.status, signal: r.signal, error: r.error?.message || null, stdout: (r.stdout || '').trim().slice(-2000), stderr: (r.stderr || '').trim().slice(-2000) }; };
  const version = run(['--version'], 20000);
  const test = run(['-p', 'Reply with the single word ok.', '--output-format', 'json', '--permission-mode', 'acceptEdits'], 90000);
  let parsed = null; try { parsed = JSON.parse(test.stdout); } catch {}
  return { bin, cwd: dir, version, test: { ...test, result: parsed ? { is_error: parsed.is_error, subtype: parsed.subtype, result: String(parsed.result || '').slice(0, 300) } : null }, path: process.env.PATH };
}
