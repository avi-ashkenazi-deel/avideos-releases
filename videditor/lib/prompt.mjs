// Builds the agent brief ("Copy Prompt") from open feedback on a version.
import { clipsAt, describeClip, fmt } from './composition.mjs';

export function buildPrompt({ project, version, feedback, composition, baseUrl, dataDir }) {
  const open = feedback.filter((f) => !f.replyTo && f.status !== 'done');
  const replies = (id) => feedback.filter((f) => f.replyTo === id);
  const lines = [];
  const live = !version;
  lines.push(`# Video review brief: ${project.name} ${live ? '(live composition)' : version.label}`);
  lines.push('');
  const run = live && open.some((f) => f.tags?.includes('run-through'));
  lines.push(live ? (run ? `You are revising a video. The reviewer played the live composition through in Videditor Studio and talked (and drew) as it ran. Each item below is timed to the moment it was said; "this" means what was on screen then. Apply all of them to the composition; the person renders.` : `You are revising a video. The reviewer paused the live composition in Videditor Studio, talked and drew on the frame. Apply the feedback to the composition; the person renders.`) : `You are revising a video. A reviewer left timestamped feedback on the current render in Videditor. Apply the feedback, render a new version, register it, then reply on each item and mark it done.`);
  lines.push('');
  lines.push(live ? `- Videditor Studio: ${baseUrl}/#/studio/${project.id}` : `- Videditor: ${baseUrl}/#/p/${project.id}?v=${version.id}`);
  if (project.dir) lines.push(`- Composition folder: ${project.dir}`);
  if (!live) lines.push(`- Reviewed render: ${version.filePath || version.mediaUrl}${version.duration ? ` (${fmt(version.duration)}, ${version.width}×${version.height})` : ''}`);
  if (!live && version.notes) lines.push(`- Notes on this version: ${version.notes.split('\n')[0]}`);
  lines.push('');
  lines.push(`## Open feedback (${open.length})`);
  if (!open.length) lines.push('_Nothing open. All feedback on this version is done._');
  open.forEach((f, i) => {
    lines.push('');
    const when = f.time === null ? 'whole video' : f.timeEnd !== null && f.timeEnd > f.time + 0.05 ? `${fmt(f.time)}–${fmt(f.timeEnd)}` : fmt(f.time);
    lines.push(`### ${i + 1}. [${when}] ${f.body ? f.body.split('\n')[0] : '(no text)'}`);
    lines.push(`- By ${f.author}, ${f.kind} note, id \`${f.id}\`${f.tags?.length ? `, tags: ${f.tags.join(', ')}` : ''}`);
    if (f.body && f.body.includes('\n')) lines.push(`- Full text: ${f.body.replace(/\n+/g, ' ')}`);
    if (f.transcript) lines.push(`- Voice transcript (verbatim): "${f.transcript}"`);
    if (f.visualReferences?.length) lines.push(`- Pointing phrases: ${f.visualReferences.map((r) => `"${r.phrase}" at ${fmt(r.time)}`).join('; ')}`);
    if (f.drawing?.strokes?.length) lines.push(`- Drawing: ${describeDrawing(f.drawing)}`);
    if (f.frames?.length) lines.push(`- Annotated frames: ${f.frames.map((fr) => `${dataDir ? dataDir + fr.url.replace(/^\/media/, '') : baseUrl + fr.url}${fr.label ? ` (${fr.label})` : ''}`).join(', ')}`);
    if (f.refs?.length) lines.push(`- Reference images: ${f.refs.map((r) => baseUrl + r).join(', ')}`);
    if (composition && f.time !== null) {
      const on = clipsAt(composition, f.time);
      lines.push(on.length ? `- On screen at ${fmt(f.time)}: ${on.map(describeClip).join('; ')}` : `- On screen at ${fmt(f.time)}: nothing timed (check the composition)`);
      const cut = lastCutBefore(composition, f.time, 1.5);
      if (cut !== null) { const before = clipsAt(composition, Math.max(0, cut - 0.05)).filter((c) => !on.includes(c)); if (before.length) lines.push(`- A cut happened ${(f.time - cut).toFixed(1)}s before this remark. Just before it: ${before.map(describeClip).join('; ')}. With a fast cut the remark may be about that section instead.`); }
    } else if (f.clipContext?.length) {
      lines.push(`- On screen: ${f.clipContext.map((c) => c.label || c.id).join('; ')}`);
    }
    for (const r of replies(f.id)) lines.push(`- Reply from ${r.author}${r.postedByAgent ? ' (agent)' : ''}: ${r.body.replace(/\n+/g, ' ')}`);
  });
  lines.push('');
  lines.push('## How to respond');
  if (live) { lines.push(`1. Edit \`${project.dir}/index.html\` (timing in \`data-start\` / \`data-duration\`; effects in \`dugma-motion.css\`; rules in \`MOTION.md\`). Change only what the notes ask.`); lines.push('2. Do not render. Reply with what changed per note (clip id, attribute, from → to).'); return lines.join('\n'); }
  const n = version.number + 1;
  if (project.dir) {
    lines.push(`1. Edit the composition in \`${project.dir}/index.html\` (the video is HTML; timing lives in \`data-start\` / \`data-duration\` attributes; the format is documented in \`videditor/skills/videditor/SKILL.md\`).`);
    lines.push(`2. Render and register v${n}: with the Videditor MCP server call \`render_version\` with project_id \`${project.id}\` and notes describing the changes. Without MCP: \`node videditor/cli.mjs render ${project.id} --notes "..."\``);
    lines.push(`3. If you produced the MP4 some other way, register it with \`version_add\` or \`node videditor/cli.mjs add-version ${project.id} path.mp4\`.`);
  } else {
    lines.push(`1. Make the edits in your editing tool and export a new MP4.`);
    lines.push(`2. Register it as v${n}: MCP \`version_add\` (project_id \`${project.id}\`) or \`node videditor/cli.mjs add-version ${project.id} path/to/v${n}.mp4 --notes "..."\``);
  }
  lines.push(`4. For each item above, reply in its thread (MCP \`feedback_post\` with reply_to) saying what changed, and set its status to done (\`feedback_update\`). Leave anything you chose not to change open, with a reply explaining why.`);
  lines.push(`5. If a note is ambiguous, ask in a reply instead of guessing.`);
  return lines.join('\n');
}

// The latest clip boundary (a start or an end) within `within` seconds before t, or null.
export function lastCutBefore(composition, t, within = 1.5) {
  let best = null;
  for (const c of composition.clips || []) {
    for (const b of [c.start, c.duration !== null && c.duration !== undefined ? c.start + c.duration : null]) {
      if (b === null || !Number.isFinite(b)) continue;
      if (b <= t + 0.05 && b >= t - within && b > 0.05 && (best === null || b > best)) best = b;
    }
  }
  return best;
}

export function describeDrawing(d) {
  const strokes = d.strokes || [];
  const tools = {};
  for (const s of strokes) tools[s.tool] = (tools[s.tool] || 0) + 1;
  const parts = Object.entries(tools).map(([t, n]) => `${n} ${t}${n > 1 ? 's' : ''}`);
  const pts = strokes.flatMap((s) => s.points);
  if (!pts.length) return parts.join(', ');
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const h = cx < 0.33 ? 'left' : cx > 0.66 ? 'right' : 'center';
  const v = cy < 0.33 ? 'top' : cy > 0.66 ? 'bottom' : 'middle';
  const region = v === 'middle' && h === 'center' ? 'center of frame' : `${v}-${h} of frame`;
  return `${parts.join(', ')} in the ${region} (${d.color || 'red'})`;
}
