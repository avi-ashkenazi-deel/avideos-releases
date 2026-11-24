import { h, button, toast } from '../dom';
import { store } from '../state';
import { collab, startSession, joinSession, leaveSession, sessionLink, savedName, inSession, others } from '../collab';

const initials = (name: string) => (name.trim().split(/\s+/).map((w) => [...w][0] ?? '').join('').slice(0, 2) || '?').toUpperCase();

/** Small coloured circle with a person's initials. */
export function avatar(p: { name: string; color: string; host?: boolean; ch?: string | null }, size = 26): HTMLElement {
  return h('span', { class: 'avatar', title: `${p.name}${p.host ? ' (host)' : ''}${p.ch ? ` · on “${p.ch}”` : ''}`, style: { background: p.color, width: `${size}px`, height: `${size}px`, lineHeight: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` } }, initials(p.name));
}

/** Header: "Share" button plus the people in the session. */
export function shareButton(): HTMLElement {
  const people = h('span', { class: 'avatars', 'data-testid': 'avatars' });
  const label = h('span', {}, 'Share');
  const btn = h('button', { type: 'button', class: 'ib', title: 'Work on this font together, live, with a link', 'data-testid': 'btn-share' }, label);
  btn.addEventListener('click', () => openShareDialog());
  const wrap = h('span', { class: 'sharewrap' }, people, btn);
  const sync = () => {
    const on = inSession();
    btn.classList.toggle('primary', on);
    label.textContent = on ? (collab.session!.role === 'host' ? 'Sharing' : 'In session') : collab.status === 'connecting' ? 'Connecting…' : 'Share';
    people.replaceChildren(...(on ? others().slice(0, 5).map((p) => avatar(p)) : []));
  };
  store.subscribe((ev) => { if (ev === 'collab') sync(); });
  sync();
  return wrap;
}

/** Start, watch or leave a shared session. */
export function openShareDialog(): HTMLDialogElement {
  const dlg = h('dialog', { class: 'modal share', 'data-testid': 'share-dialog' });
  const body = h('div', {});
  const via: 'peer' | 'local' = new URLSearchParams(location.search).get('via') === 'local' ? 'local' : 'peer';

  const render = () => {
    const s = collab.session;
    if (!s || collab.status !== 'open') {
      const name = h('input', { type: 'text', value: savedName(), placeholder: 'Your name', maxlength: 40, 'aria-label': 'Your name', 'data-testid': 'share-name' }) as HTMLInputElement;
      const status = h('div', { class: 'status' }, collab.status === 'error' ? `Could not start: ${collab.detail}` : '');
      const start = button('Start a session', async () => {
        if (!name.value.trim()) { name.focus(); toast('Add your name so others know who is who.'); return; }
        start.disabled = true; status.textContent = 'Connecting…';
        try { await startSession(name.value, via); render(); }
        catch (e) { status.textContent = `Could not start: ${(e as Error).message}. Some office networks block direct connections.`; start.disabled = false; }
      }, 'primary');
      start.dataset.testid = 'share-start';
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') start.click(); });
      body.replaceChildren(
        h('p', {}, 'Work on this font with other people at the same time. You start a session, send them the link, and everyone sees each other’s changes as they happen.'),
        h('ul', { class: 'sharefacts' },
          h('li', {}, 'The font travels straight between your browsers. Nothing is stored on a server.'),
          h('li', {}, 'The session lasts while this tab stays open. The font keeps living in your “My fonts”.'),
          h('li', {}, 'One person works on a letter at a time; you see who is where.')),
        h('div', { class: 'row' }, h('label', {}, 'Your name ', name), start),
        status,
      );
      return;
    }
    const host = s.role === 'host';
    const link = h('input', { type: 'text', readonly: true, value: sessionLink(), class: 'sharelink', 'aria-label': 'Link to this session', 'data-testid': 'share-link' }) as HTMLInputElement;
    link.addEventListener('focus', () => link.select());
    const copy = button('Copy link', async () => {
      try { await navigator.clipboard.writeText(link.value); toast('Link copied. Send it to the people you want to work with.'); }
      catch { link.select(); toast('Select the link and copy it.'); }
    }, 'primary');
    const canEdit = h('input', { type: 'checkbox', checked: s.guestsCanEdit, id: 'guestsedit', 'data-testid': 'share-canedit' }) as HTMLInputElement;
    canEdit.addEventListener('change', () => s.setGuestsCanEdit(canEdit.checked));
    const list = h('div', { class: 'sharepeople', 'data-testid': 'share-people' }, ...collab.peers.map((p) => h('div', { class: 'shareperson' },
      avatar(p, 30),
      h('div', {}, h('strong', {}, p.name), p.id === s.me.id ? h('span', { class: 'muted' }, ' (you)') : null,
        h('div', { class: 'muted small' }, `${p.host ? 'Host' : p.canEdit ? 'Can edit' : 'Watching, can leave notes'}${p.ch ? ` · on “${p.ch}”` : ''}`)))));
    const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    body.replaceChildren(
      ...(host ? [
        h('p', {}, 'Send this link. Anyone who opens it joins your font.'),
        h('div', { class: 'row' }, link, copy),
        ...(local ? [h('p', { class: 'muted small' }, 'This link points at FontLab on your own computer. It works for people who also run FontLab on theirs (same address), or for everyone once the app is online.')] : []),
        h('div', { class: 'row' }, h('label', { class: 'toggle', for: 'guestsedit' }, canEdit, ' Guests can edit'), h('small', { class: 'muted' }, 'Off: guests watch live and can leave notes, only you edit.')),
      ] : [h('p', {}, `You are in ${collab.peers.find((p) => p.host)?.name ?? 'the host'}’s session. ${s.me.canEdit ? 'Your edits show up for everyone.' : 'You can watch live and leave notes (N); only the host edits.'}`)]),
      h('h3', {}, `People (${collab.peers.length})`),
      list,
      h('div', { class: 'row' }, button(host ? 'End session' : 'Leave session', () => { leaveSession(); dlg.close(); }, 'danger')),
    );
  };
  const off = store.subscribe((ev) => { if (ev === 'collab' && dlg.isConnected) render(); });
  dlg.append(h('h2', {}, 'Share session'), body, h('div', { class: 'row' }, button('Close', () => dlg.close())));
  dlg.addEventListener('close', () => { off(); dlg.remove(); });
  render();
  document.body.append(dlg); dlg.showModal();
  return dlg;
}

/** Opened from a session link (?join=ROOM): ask for a name, then join. */
export function openJoinDialog(room: string, via: 'peer' | 'local'): HTMLDialogElement {
  const dlg = h('dialog', { class: 'modal share', 'data-testid': 'join-dialog' });
  const name = h('input', { type: 'text', value: savedName(), placeholder: 'Your name', maxlength: 40, 'aria-label': 'Your name', 'data-testid': 'join-name' }) as HTMLInputElement;
  const status = h('div', { class: 'status' });
  const strip = () => { const u = new URL(location.href); u.searchParams.delete('join'); history.replaceState(null, '', u.toString()); };
  const join = button('Join', async () => {
    if (!name.value.trim()) { name.focus(); return; }
    join.disabled = true; status.textContent = 'Connecting…';
    try { await joinSession(room, name.value, via); strip(); dlg.close(); toast('You joined the session. The shared font is on screen; your own fonts are safe in My fonts.', 5000); }
    catch (e) { status.textContent = `Could not join: ${(e as Error).message}. The host may have closed the tab, or a network is blocking direct connections.`; join.disabled = false; }
  }, 'primary');
  join.dataset.testid = 'join-go';
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') join.click(); });
  dlg.append(
    h('h2', {}, 'Join a shared font'),
    h('p', {}, 'Someone invited you to work on their font. It opens here while the session lasts; the font you had open stays saved.'),
    h('div', { class: 'row' }, h('label', {}, 'Your name ', name), join, button('Not now', () => { strip(); dlg.close(); })),
    status,
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
  return dlg;
}
