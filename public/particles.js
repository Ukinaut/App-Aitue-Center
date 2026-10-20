// Constelación AITUE: puntos y conexiones azules sobre el cuerpo blanco.
const canvas = document.querySelector('#body-particles');
const context = canvas?.getContext('2d');
if (context) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0, height = 0, points = [], frame = 0, lastTime = 0, lastDraw = 0;
  const random = (min, max) => min + Math.random() * (max - min);

  function resize() {
    const oldWidth = width, oldHeight = height;
    width = document.documentElement.clientWidth;
    height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.min(76, Math.max(24, Math.round(width * height / 16000)));
    points = Array.from({ length: count }, (_, index) => {
      const previous = points[index];
      return {
        x: previous && oldWidth ? previous.x / oldWidth * width : random(0, width),
        y: previous && oldHeight ? previous.y / oldHeight * height : random(0, height),
        vx: previous?.vx ?? random(-9, 9),
        vy: previous?.vy ?? random(-9, 9),
        radius: previous?.radius ?? random(1.4, 2.5),
      };
    });
    draw(0);
  }

  function draw(delta) {
    context.clearRect(0, 0, width, height);
    for (const point of points) {
      point.x = (point.x + point.vx * delta + width) % width;
      point.y = (point.y + point.vy * delta + height) % height;
    }
    const reach = width < 600 ? 120 : 165;
    context.lineWidth = 0.8;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const distance = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
        if (distance >= reach) continue;
        context.strokeStyle = `rgba(44,110,219,${0.2 * (1 - distance / reach)})`;
        context.beginPath();
        context.moveTo(points[i].x, points[i].y);
        context.lineTo(points[j].x, points[j].y);
        context.stroke();
      }
    }
    for (const point of points) {
      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, point.radius * 3);
      glow.addColorStop(0, 'rgba(44,110,219,.22)');
      glow.addColorStop(1, 'rgba(89,168,255,0)');
      context.fillStyle = glow;
      context.beginPath();
      context.arc(point.x, point.y, point.radius * 3, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = 'rgba(44,110,219,.58)';
      context.beginPath();
      context.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
      context.fill();
    }
  }

  function animate(time) {
    if (!lastTime) lastTime = time;
    if (time - lastDraw >= 1000 / 30) {
      draw(Math.min((time - lastTime) / 1000, 0.08));
      lastTime = time;
      lastDraw = time;
    }
    frame = requestAnimationFrame(animate);
  }

  function syncMotion() {
    cancelAnimationFrame(frame);
    lastTime = 0;
    lastDraw = 0;
    if (reducedMotion.matches || document.hidden) {
      canvas.dataset.animation = reducedMotion.matches ? 'reduced' : 'paused';
      draw(0);
      return;
    }
    canvas.dataset.animation = 'running';
    frame = requestAnimationFrame(animate);
  }
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', syncMotion);
  reducedMotion.addEventListener('change', syncMotion);
  resize();
  syncMotion();
}
