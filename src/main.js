import './style.css';
import { FORTRESSES, commonsUrl } from './fortresses/index.js';
import { mountViewer } from './app/viewer.js';

const app = document.getElementById('app');
let current = null; // { dispose }

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [id] = hash.split('/');
  if (current) { current.dispose(); current = null; }
  app.innerHTML = '';
  const entry = FORTRESSES.find((f) => f.id === id && f.status === 'live');
  if (entry) current = mountViewer(app, entry);
  else current = mountLanding(app);
}

function mountLanding(root) {
  const el = document.createElement('div');
  el.className = 'landing';
  const live = FORTRESSES.filter((f) => f.status === 'live');
  const soon = FORTRESSES.filter((f) => f.status !== 'live');
  el.innerHTML = `
    <header class="brand-bar">
      <a class="brand" href="#/"><span class="brand-mark"></span>Fortress Breakdown</a>
      <nav><a href="https://github.com/" target="_blank" rel="noopener" class="muted small" data-repo>GitHub</a></nav>
    </header>
    <section class="hero">
      <p class="eyebrow">Interactive 3D histories of fortification</p>
      <h1>How great fortresses <em>actually</em> worked.</h1>
      <p class="lede">Walk the walls in 3D, see every tower’s field of fire, scrub through centuries of construction and replay the sieges they survived.</p>
    </section>
    <section class="cards">
      ${live.map((f) => `
        <a class="card live" href="#/${f.id}" style="--img:url('${commonsUrl(f.hero, 1200)}')">
          <div class="card-img"></div>
          <div class="card-body">
            <p class="eyebrow">${f.country} · ${f.era}</p>
            <h2>${f.name}</h2>
            <p>${f.tagline}</p>
            <span class="cta">Enter the 3D breakdown →</span>
          </div>
          <span class="credit">Photo: ${f.heroCredit}</span>
        </a>`).join('')}
      ${soon.map((f) => `
        <div class="card soon">
          <div class="card-body">
            <p class="eyebrow">${f.country} · ${f.era}</p>
            <h2>${f.name}</h2>
            <p>${f.tagline}</p>
            <span class="pill">Coming soon</span>
          </div>
        </div>`).join('')}
    </section>
    <footer class="foot">
      <p>Built with three.js. 3D models are stylised reconstructions generated procedurally from historical plans — not survey data. Photographs via Wikimedia Commons under their stated licences.</p>
    </footer>`;
  root.appendChild(el);
  return { dispose() { el.remove(); } };
}

window.addEventListener('hashchange', route);
route();
