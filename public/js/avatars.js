/*
 * Cartoon characters, drawn as SVG from small data specs.
 * A diverse cast: different skin tones, hair textures and styles, head
 * coverings, ages, glasses, a hearing aid, facial hair, and so on.
 */
const Avatars = (() => {
  const OUT = '#2b2140';
  const SW = 2.6;
  const line = `stroke="${OUT}" stroke-width="${SW}" stroke-linejoin="round" stroke-linecap="round"`;

  const LIST = [
    { name: 'Amara', skin: '#6f4428', shirt: '#ffc233', hair: 'afro', hairColor: '#1e1512', extras: ['hoops'], mouth: 'smile' },
    { name: 'Kenji', skin: '#f3d3ae', shirt: '#ef476f', hair: 'spiky', hairColor: '#1b1a24', extras: [], mouth: 'grin' },
    { name: 'Priya', skin: '#b2754a', shirt: '#14b8a6', hair: 'braid', hairColor: '#1c1416', extras: ['bindi'], mouth: 'smile' },
    { name: 'Mateo', skin: '#cf9564', shirt: '#2fbf71', hair: 'curly', hairColor: '#4a2a18', extras: ['stache'], mouth: 'grin' },
    { name: 'Layla', skin: '#e0b184', shirt: '#7c5cff', hair: 'hijab', hairColor: '#ff7eb6', extras: [], mouth: 'smile' },
    { name: 'Jamal', skin: '#4b2c1c', shirt: '#ff8a3d', hair: 'locs', hairColor: '#150e0c', facial: '#150e0c', extras: ['beard'], mouth: 'smile' },
    { name: 'Sofia', skin: '#f9ddc9', shirt: '#3b82f6', hair: 'curly', hairColor: '#c9501c', extras: ['freckles', 'glasses'], mouth: 'smile' },
    { name: 'Arjun', skin: '#946034', shirt: '#0ea5e9', hair: 'turban', hairColor: '#ff9f1c', facial: '#2a1a12', extras: ['beard'], mouth: 'smile' },
    { name: 'Mei', skin: '#f6dcbd', shirt: '#f472b6', hair: 'bob', hairColor: '#1a1620', extras: [], mouth: 'smile' },
    { name: 'Sam', skin: '#d9a47a', shirt: '#64748b', hair: 'short', hairColor: '#19c6b4', extras: ['hearing'], mouth: 'grin' },
    { name: 'Rosa', skin: '#ecc3a0', shirt: '#a855f7', hair: 'bun', hairColor: '#d9d9e4', extras: ['roundglasses', 'wrinkles'], mouth: 'smile' },
    { name: 'Tane', skin: '#a9714b', shirt: '#22c55e', hair: 'wavy', hairColor: '#17110f', extras: ['flower'], mouth: 'grin' },
  ];

  // [behind body, in front of head]
  const HAIR = {
    afro: (c) => [
      `<circle cx="50" cy="35" r="35" fill="${c}" ${line}/>`,
      `<path d="M26 41 C26 24 74 24 74 41 C68 32 58 29 50 29 C42 29 32 32 26 41Z" fill="${c}"/>`,
    ],
    spiky: (c) => [
      '',
      `<path d="M25 42 L21 22 L35 29 L38 11 L48 26 L58 9 L63 27 L77 19 L75 42 C69 31 58 28 50 28 C42 28 31 31 25 42Z" fill="${c}" ${line}/>`,
    ],
    braid: (c) => [
      `<path d="M24 40 C20 14 80 14 76 40 L76 56 L24 56Z" fill="${c}" ${line}/>`,
      `<path d="M25 43 C23 18 77 18 75 43 C70 31 58 27 50 27 C42 27 30 31 25 43Z" fill="${c}"/>` +
      `<path d="M71 60 Q82 70 76 84 Q74 91 72 95" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round"/>` +
      `<path d="M71 60 Q82 70 76 84 Q74 91 72 95" fill="none" stroke="${OUT}" stroke-width="1.4" stroke-dasharray="3 4" stroke-linecap="round"/>` +
      '<circle cx="72" cy="94" r="3.2" fill="#ff5d73" stroke="#2b2140" stroke-width="1.6"/>',
    ],
    curly: (c) => [
      '',
      [[30, 29, 10], [42, 21, 11], [56, 21, 11], [69, 29, 10], [24, 41, 7.5], [76, 41, 7.5], [50, 24, 10]]
        .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" ${line}/>`).join('') +
      `<path d="M27 38 C30 28 70 28 73 38 C66 33 34 33 27 38Z" fill="${c}"/>`,
    ],
    hijab: (c) => [
      '',
      `<path fill-rule="evenodd" d="M20 50 C14 12 86 12 80 50 C82 72 70 84 50 84 C30 84 18 72 20 50Z M50 24 C36 24 30 36 30 48 C30 60 38 68 50 68 C62 68 70 60 70 48 C70 36 64 24 50 24Z" fill="${c}" ${line}/>` +
      `<path d="M24 76 C30 92 70 92 76 76 L84 100 L16 100Z" fill="${c}" ${line}/>`,
    ],
    locs: (c) => [
      [24, 29, 74, 79].map((x) => `<path d="M${x} 34 L${x - (x < 50 ? 2 : -2)} 74" stroke="${c}" stroke-width="8" stroke-linecap="round"/>`).join('') +
      [27, 73].map((x) => `<path d="M${x} 40 L${x + (x < 50 ? -2 : 2)} 82" stroke="${c}" stroke-width="7" stroke-linecap="round"/>`).join(''),
      `<path d="M24 43 C20 12 80 12 76 43 C70 29 58 24 50 24 C42 24 30 29 24 43Z" fill="${c}" ${line}/>`,
    ],
    turban: (c) => [
      '',
      `<path d="M21 43 C13 14 32 1 50 1 C68 1 87 14 79 43 C70 35 30 35 21 43Z" fill="${c}" ${line}/>` +
      `<path d="M25 34 Q50 20 75 34 M23 25 Q50 10 77 25" fill="none" stroke="${OUT}" stroke-width="1.8" stroke-linecap="round" opacity=".45"/>` +
      '<circle cx="50" cy="28" r="4" fill="#ffe066" stroke="#2b2140" stroke-width="1.8"/>',
    ],
    bob: (c) => [
      `<path d="M20 34 C20 8 80 8 80 34 L80 66 Q80 71 74 71 L26 71 Q20 71 20 66Z" fill="${c}" ${line}/>`,
      `<path d="M24 41 C22 14 78 14 76 41 L76 33 L24 33Z" fill="${c}"/>` +
      `<path d="M24 34 L76 34" stroke="${OUT}" stroke-width="1.4" opacity=".35"/>`,
    ],
    short: (c) => [
      '',
      `<path d="M25 44 C21 14 79 14 75 44 C71 34 60 24 46 26 C37 28 29 34 25 44Z" fill="${c}" ${line}/>`,
    ],
    bun: (c) => [
      `<circle cx="50" cy="12" r="11" fill="${c}" ${line}/>`,
      `<path d="M25 44 C22 16 78 16 75 44 C70 31 30 31 25 44Z" fill="${c}" ${line}/>`,
    ],
    wavy: (c) => [
      `<path d="M21 40 C14 62 22 78 18 90 C30 96 40 90 44 84 L56 84 C60 90 70 96 82 90 C78 78 86 62 79 40Z" fill="${c}" ${line}/>`,
      `<path d="M24 44 C22 16 78 16 76 44 C68 30 40 26 24 44Z" fill="${c}"/>`,
    ],
  };

  const EXTRAS = {
    hoops: () => [26, 74].map((x) => `<circle cx="${x}" cy="56" r="4.6" fill="none" stroke="#ffd23f" stroke-width="2.2"/>`).join(''),
    bindi: () => '<circle cx="50" cy="31" r="2.2" fill="#e11d48"/>',
    stache: (s, a) => `<path d="M38 55 Q44 50 50 54 Q56 50 62 55 Q56 59 50 56 Q44 59 38 55Z" fill="${a.facial || a.hairColor}" ${line}/>`,
    beard: (s, a) =>
      `<path d="M25 50 C25 74 40 78 50 78 C60 78 75 74 75 50 C72 60 64 62 58 60 L42 60 C36 62 28 60 25 50Z" fill="${a.facial || a.hairColor}" ${line}/>` +
      `<ellipse cx="50" cy="58" rx="9" ry="5" fill="${s}"/>`,
    freckles: () => [[36, 51], [40, 53], [33, 54], [64, 51], [60, 53], [67, 54]]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.1" fill="#b4573b" opacity=".75"/>`).join(''),
    glasses: () => `<rect x="30" y="37" width="17" height="13" rx="4" fill="#bde6ff" fill-opacity=".35" stroke="${OUT}" stroke-width="2.4"/>` +
      `<rect x="53" y="37" width="17" height="13" rx="4" fill="#bde6ff" fill-opacity=".35" stroke="${OUT}" stroke-width="2.4"/>` +
      `<path d="M47 43 H53 M30 42 L25 40 M70 42 L75 40" stroke="${OUT}" stroke-width="2.2" stroke-linecap="round"/>`,
    roundglasses: () => `<circle cx="39.5" cy="44" r="8.5" fill="#fff" fill-opacity=".35" stroke="${OUT}" stroke-width="2.4"/>` +
      `<circle cx="60.5" cy="44" r="8.5" fill="#fff" fill-opacity=".35" stroke="${OUT}" stroke-width="2.4"/>` +
      `<path d="M48 43 Q50 41 52 43" fill="none" stroke="${OUT}" stroke-width="2.2"/>`,
    wrinkles: () => `<path d="M28 47 q-2 2 0 4 M72 47 q2 2 0 4 M41 29 q9 -3 18 0" fill="none" stroke="${OUT}" stroke-width="1.3" opacity=".35" stroke-linecap="round"/>`,
    hearing: () => '<path d="M76 38 Q84 42 80 54" fill="none" stroke="#e9b98d" stroke-width="4.2" stroke-linecap="round"/>' +
      `<circle cx="79.5" cy="55" r="3" fill="#e9b98d" stroke="${OUT}" stroke-width="1.6"/>`,
    flower: () => {
      const petals = [0, 72, 144, 216, 288].map((d) =>
        `<ellipse cx="0" cy="-5" rx="3.6" ry="5.2" fill="#ff4d6d" stroke="${OUT}" stroke-width="1.3" transform="rotate(${d})"/>`).join('');
      return `<g transform="translate(31 31)">${petals}<circle r="2.6" fill="#ffe066" stroke="${OUT}" stroke-width="1.2"/></g>`;
    },
  };

  // Features that must sit *behind* the face drawing (beard, stache) vs on top.
  const BEHIND_FEATURES = new Set(['beard']);

  function svg(index) {
    const a = LIST[index % LIST.length];
    const s = a.skin;
    const [back, front] = HAIR[a.hair](a.hairColor);
    const browColor = ['hijab', 'turban'].includes(a.hair) ? '#3a2a22' : a.hairColor;
    const ex = (names, filter) => a.extras.filter((n) => filter(n)).map((n) => EXTRAS[n](s, a)).join('');
    const mouth = a.mouth === 'grin'
      ? `<path d="M41 55 Q50 66 59 55 Z" fill="#7a1f3d" ${line}/><path d="M44 58 Q50 62 56 58 Q50 60 44 58Z" fill="#ff8aa1"/>`
      : `<path d="M42 56 Q50 63 58 56" fill="none" ${line}/>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 100 100">
${back}
<path d="M17 100 C17 80 31 71 50 71 C69 71 83 80 83 100Z" fill="${a.shirt}" ${line}/>
<path d="M41 71 Q50 80 59 71" fill="none" stroke="${OUT}" stroke-width="2" opacity=".35" stroke-linecap="round"/>
<rect x="42.5" y="58" width="15" height="17" rx="6" fill="${s}" ${line}/>
<circle cx="25.5" cy="46" r="5.6" fill="${s}" ${line}/><circle cx="74.5" cy="46" r="5.6" fill="${s}" ${line}/>
<ellipse cx="50" cy="42" rx="25" ry="26" fill="${s}" ${line}/>
${front}
${ex(a.extras, (n) => BEHIND_FEATURES.has(n))}
<path d="M31 36 Q38 32 45 35 M55 35 Q62 32 69 36" fill="none" stroke="${browColor}" stroke-width="3.2" stroke-linecap="round"/>
<ellipse cx="39.5" cy="44" rx="3.3" ry="4.3" fill="${OUT}"/><ellipse cx="60.5" cy="44" rx="3.3" ry="4.3" fill="${OUT}"/>
<circle cx="40.8" cy="42.5" r="1.3" fill="#fff"/><circle cx="61.8" cy="42.5" r="1.3" fill="#fff"/>
<circle cx="32" cy="53" r="4.2" fill="#ff6b8b" opacity=".28"/><circle cx="68" cy="53" r="4.2" fill="#ff6b8b" opacity=".28"/>
${mouth}
${ex(a.extras, (n) => !BEHIND_FEATURES.has(n))}
</svg>`;
  }

  const urlCache = new Map();
  const imgCache = new Map();

  function url(index) {
    if (!urlCache.has(index)) urlCache.set(index, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg(index)));
    return urlCache.get(index);
  }

  /** Cached <img> element (decoded) for canvas drawing. */
  function image(index) {
    let img = imgCache.get(index);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.src = url(index);
      imgCache.set(index, img);
    }
    return img;
  }

  return { LIST, count: LIST.length, svg, url, image };
})();
