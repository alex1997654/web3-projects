// Scroll reveals
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// Copy-to-clipboard for verify commands
document.querySelectorAll('.copy').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const old = btn.textContent;
      btn.textContent = 'copied';
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1600);
    } catch { /* clipboard unavailable: leave the command visible to copy manually */ }
  });
});

// Live devnet balance badge for the shared portfolio payer
(async () => {
  const PAYER = '9swJ3NhMEBAWZ77cde9HG8jmFWL9Y5rDszKYbyVvceQP';
  const dot = document.getElementById('devnet-dot');
  const text = document.getElementById('devnet-text');
  if (!dot || !text) return;
  try {
    const res = await fetch('https://api.devnet.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [PAYER] }),
    });
    const data = await res.json();
    const sol = data.result.value / 1e9;
    dot.classList.add('on');
    text.textContent = 'devnet online · ' + sol.toFixed(2) + ' SOL';
  } catch {
    text.textContent = 'devnet';
  }
})();
