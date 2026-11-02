// Builds the agent brief ("Copy Prompt") from open feedback on a version.
import { clipsAt, describeClip, fmt } from './composition.mjs';

export function buildPrompt({ project, version, feedback, composition, baseUrl, dataDir }) {
  const open = feedback.filter((f) => !f.replyTo && f.status !== 'done');
  const replies = (id) => feedback.filter((f) => f.replyTo === id);
  const lines = [];
  lines.push(`# Video review brief: ${project.name} ${version.label}`);
  lines.push('');
  lines.push(`You are revising a video. A reviewer left timestamped feedback on the current render in Videditor. Apply the feedback, render a new version, register it, then reply on each item and mark it done.`);
  lines.push('');
  lines.push(`- Videditor: ${baseUrl}/#/p/${project.id}?v=${version.id}`);
  if (project.dir) lines.push(`- Composition folder: ${project.dir}`);
  lines.push(`- Reviewed render: ${version.filePath || version.mediaUrl}${version.duration ? ` (${fmt(version.duration)}, ${version.width}×${version.height})` : ''}`);
  if (version.notes) lines.push(`- Notes on this version: ${version.notes.split('\n')[0]}`);
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
    } else if (f.clipContext?.length) {
      lines.push(`- On screen: ${f.clipContext.map((c) => c.label || c.id).join('; ')}`);
    }
    for (const r of replies(f.id)) lines.push(`- Reply from ${r.author}${r.postedByAgent ? ' (agent)' : ''}: ${r.body.replace(/\n+/g, ' ')}`);
  });
  lines.push('');
  lines.push('## How to respond');
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
