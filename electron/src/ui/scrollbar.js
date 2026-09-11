export function attachScrollbar(payload, track, thumb) {
  let drag = null;
  let frame = null;
  const maximum = () => Math.max(0, payload.scrollHeight - payload.clientHeight);
  function update() {
    frame = null;
    const max = maximum();
    track.hidden = max <= 1;
    track.tabIndex = max > 1 ? 0 : -1;
    track.setAttribute('aria-hidden', String(max <= 1));
    const height = track.clientHeight;
    const thumbHeight = Math.min(height, Math.max(32, height * payload.clientHeight / Math.max(1, payload.scrollHeight)));
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.top = `${max > 0 ? payload.scrollTop / max * (height - thumbHeight) : 0}px`;
    const percent = Math.round(max > 0 ? payload.scrollTop / max * 100 : 0);
    track.setAttribute('aria-valuenow', String(percent));
    track.setAttribute('aria-valuetext', `${percent}% of payload`);
  }
  function schedule() {
    if (frame === null && !document.hidden) frame = requestAnimationFrame(update);
  }
  function move(event) {
    if (!drag) return;
    const travel = track.clientHeight - thumb.clientHeight;
    payload.scrollTop = (event.clientY - track.getBoundingClientRect().top - drag.offset) / Math.max(1, travel) * maximum();
  }
  function release() { drag = null; track.classList.remove('dragging'); }
  track.addEventListener('pointerdown', event => {
    if (event.button !== 0 || track.hidden) return;
    event.preventDefault();
    const bounds = thumb.getBoundingClientRect();
    drag = { offset: event.target === thumb ? event.clientY - bounds.top : bounds.height / 2 };
    track.setPointerCapture(event.pointerId);
    track.classList.add('dragging');
    track.focus();
    move(event);
  });
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);
  track.addEventListener('lostpointercapture', release);
  track.addEventListener('keydown', event => {
    const changes = { ArrowUp: -40, ArrowDown: 40, ArrowLeft: -40, ArrowRight: 40,
      PageUp: -payload.clientHeight * .8, PageDown: payload.clientHeight * .8,
      Home: -payload.scrollHeight, End: payload.scrollHeight };
    if (Object.hasOwn(changes, event.key)) { event.preventDefault(); payload.scrollTop += changes[event.key]; }
  });
  track.addEventListener('wheel', event => {
    event.preventDefault();
    payload.scrollTop += event.deltaY * (event.deltaMode === 1 ? 26 : event.deltaMode === 2 ? payload.clientHeight : 1);
  }, { passive: false });
  payload.addEventListener('scroll', schedule, { passive: true });
  document.addEventListener('visibilitychange', schedule);
  new ResizeObserver(schedule).observe(payload);
  new ResizeObserver(schedule).observe(payload.firstElementChild);
  schedule();
  return schedule;
}
