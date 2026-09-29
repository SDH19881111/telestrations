// 그림판: 펜, 색상, 굵기, 지우개, 되돌리기, 전체 지우기 (Pointer Events로 마우스·터치 공통 처리)
export const COLORS = ['#222222', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5'];
export const SIZES = [4, 10, 22];
const BG = '#ffffff';
const SIZE = 600; // 내부 해상도(정사각형). 화면에는 CSS로 맞춰 늘리고 줄인다.

export class Sketch {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = SIZE;
    canvas.height = SIZE;
    this.ctx = canvas.getContext('2d');
    this.color = COLORS[0];
    this.size = SIZES[1];
    this.eraser = false;
    this.actions = []; // {color, size, points:[[x,y]...]} 또는 {clear:true}
    this.current = null;
    this.enabled = true;
    this.onChange = () => {};
    this.redraw();

    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [
      Math.round(((e.clientX - r.left) / r.width) * SIZE * 10) / 10,
      Math.round(((e.clientY - r.top) / r.height) * SIZE * 10) / 10,
    ];
  }

  down(e) {
    if (!this.enabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.current = { color: this.eraser ? BG : this.color, size: this.eraser ? this.size * 2 : this.size, points: [this.pos(e)] };
    this.pointerId = e.pointerId;
    this.drawStroke(this.current);
  }

  move(e) {
    if (!this.current || e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const pts = this.current.points;
    for (const ev of (events.length ? events : [e])) {
      const p = this.pos(ev);
      const last = pts[pts.length - 1];
      pts.push(p);
      this.segment(this.current, last, p);
    }
  }

  up(e) {
    if (!this.current || e.pointerId !== this.pointerId) return;
    this.actions.push(this.current);
    this.current = null;
    this.onChange();
  }

  segment(stroke, a, b) {
    const { ctx } = this;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }

  drawStroke(stroke) {
    const { ctx } = this;
    const pts = stroke.points;
    if (pts.length === 1) {
      ctx.fillStyle = stroke.color;
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  redraw() {
    const { ctx } = this;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, SIZE, SIZE);
    for (const a of this.actions) {
      if (a.clear) { ctx.fillStyle = BG; ctx.fillRect(0, 0, SIZE, SIZE); } else this.drawStroke(a);
    }
  }

  setColor(c) { this.color = c; this.eraser = false; }
  setSize(s) { this.size = s; }
  setEraser(on) { this.eraser = on; }

  undo() {
    if (!this.actions.length) return;
    this.actions.pop();
    this.redraw();
    this.onChange();
  }

  clear() {
    if (this.isEmpty()) return;
    this.actions.push({ clear: true }); // 되돌리기로 복구할 수 있게 동작으로 기록
    this.redraw();
    this.onChange();
  }

  reset() {
    this.actions = [];
    this.current = null;
    this.redraw();
    this.onChange();
  }

  /** 저장해 둔 동작 목록으로 되살린다 (튕겼다가 돌아왔을 때) */
  load(actions) {
    this.actions = Array.isArray(actions) ? actions : [];
    this.current = null;
    this.redraw();
  }

  isEmpty() {
    const last = this.actions[this.actions.length - 1];
    return !last || !!last.clear;
  }

  /** 제출용 이미지. webp 인코딩을 못 하는 브라우저(구형 Safari)는 jpeg로 대체 */
  toDataURL() {
    if (this.current) this.up({ pointerId: this.pointerId });
    const webp = this.canvas.toDataURL('image/webp', 0.7);
    if (webp.startsWith('data:image/webp')) return webp;
    return this.canvas.toDataURL('image/jpeg', 0.75);
  }
}
