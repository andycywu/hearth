/**
 * The avatars: faces for Hearth, drawn in SVG so they cost no assets and scale to a TV.
 *
 * One face per state, in the same colours the status ring uses — the ring and the face are two views of one
 * fact, and a person who has learned that green means done should not have to learn it again for a cartoon
 * fox. Each avatar is a head shape and a few features around a shared set of eyes and mouths; the state
 * (`data-state` on the SVG) decides which mouth shows, how the eyes look, and whether the halo moves.
 *
 * Plain script in a string: it is served as part of the lab page, which has no build step and fetches
 * nothing. It uses no backticks and no template placeholders, so it can sit inside the page's own template.
 */

export const AVATAR_IDS = ["orb", "robot", "cat", "owl", "fox", "ghost"] as const;
export type AvatarId = (typeof AVATAR_IDS)[number];

export function isAvatarId(v: unknown): v is AvatarId {
  return typeof v === "string" && (AVATAR_IDS as readonly string[]).includes(v);
}

export const AVATAR_CSS = String.raw`
  .avatar { width:100%; height:auto; display:block; }
  .avatar .halo { fill:none; stroke:var(--halo, #5a8cff); stroke-width:5; opacity:.9; transform-origin:100px 100px; filter: drop-shadow(0 0 1.5px rgba(0,0,0,.55)); }
  .avatar .halo-dash { stroke-dasharray:14 12; }
  .avatar .eye { transition: transform .25s; transform-box: fill-box; transform-origin:center; }
  .avatar .pupil { transition: transform .3s; }
  .avatar .m, .avatar .happy, .avatar .dizzy, .avatar .zzz, .avatar .dots { display:none; }
  .avatar .happy, .avatar .m, .avatar .dizzy { fill:none; stroke:#10161f; stroke-width:5; stroke-linecap:round; }
  .avatar .m-talk { fill:#10161f; stroke:none; }
  .avatar .zzz { fill:#9aa7b6; font:700 18px system-ui, sans-serif; }
  .avatar .dots circle { fill:#9aa7b6; }
  @keyframes av-blink { 0%,92%,100% { transform:scaleY(1); } 96% { transform:scaleY(.08); } }
  @keyframes av-breathe { 0%,100% { transform:scale(1); opacity:.55; } 50% { transform:scale(1.06); opacity:1; } }
  @keyframes av-spin { to { transform:rotate(360deg); } }
  @keyframes av-talk { 0%,100% { transform:scaleY(.25); } 50% { transform:scaleY(1); } }
  @keyframes av-dots { 0%,100% { opacity:.25; } 50% { opacity:1; } }
  @keyframes av-blinkhalo { 0%,49% { opacity:.95; } 50%,100% { opacity:.1; } }
  .avatar[data-state="listening"] .eye { animation: av-blink 5s infinite; }
  .avatar[data-state="listening"] .m-smile { display:block; }
  .avatar[data-state="listening"] .halo { --halo:#2a5cff; opacity:.5; }

  .avatar[data-state="loading"] { --halo:#00aaaa; }
  .avatar[data-state="loading"] .halo { animation: av-spin 2.4s linear infinite; }
  .avatar[data-state="loading"] .eye { transform:scaleY(.35); }
  .avatar[data-state="loading"] .m-flat { display:block; }

  .avatar[data-state="hearing"] { --halo:#3ca0ff; }
  .avatar[data-state="hearing"] .halo { animation: av-breathe 1.6s ease-in-out infinite; }
  .avatar[data-state="hearing"] .eye { transform:scale(1.22); }
  .avatar[data-state="hearing"] .m-o { display:block; }
  .avatar[data-state="hearing"] .ear { transform:translateY(-7px); }

  .avatar[data-state="recognizing"] { --halo:#b4d2ff; }
  .avatar[data-state="recognizing"] .halo { animation: av-spin 1.6s linear infinite; }
  .avatar[data-state="recognizing"] .pupil { transform:translateX(5px); }
  .avatar[data-state="recognizing"] .m-flat { display:block; }

  .avatar[data-state="thinking"] { --halo:#ffffff; }
  .avatar[data-state="thinking"] .halo { animation: av-spin 1.1s linear infinite; }
  .avatar[data-state="thinking"] .pupil { transform:translate(-5px,-5px); }
  .avatar[data-state="thinking"] .m-flat { display:block; }
  .avatar[data-state="thinking"] .dots { display:block; }
  .avatar[data-state="thinking"] .dots circle { animation: av-dots 1.2s infinite; }
  .avatar[data-state="thinking"] .dots circle:nth-child(2) { animation-delay:.25s; }
  .avatar[data-state="thinking"] .dots circle:nth-child(3) { animation-delay:.5s; }

  .avatar[data-state="acting"] { --halo:#00dcff; }
  .avatar[data-state="acting"] .halo { animation: av-spin .6s linear infinite; }
  .avatar[data-state="acting"] .eye { transform:scaleY(.55); }
  .avatar[data-state="acting"] .m-flat { display:block; }

  .avatar[data-state="speaking"] { --halo:#ff00a0; }
  .avatar[data-state="speaking"] .halo { animation: av-breathe 1.1s ease-in-out infinite; }
  .avatar[data-state="speaking"] .m-talk { display:block; transform-box: fill-box; transform-origin:center; animation: av-talk .32s ease-in-out infinite; }

  .avatar[data-state="verified"] { --halo:#00ff3c; }
  .avatar[data-state="verified"] .eye { display:none; }
  .avatar[data-state="verified"] .happy, .avatar[data-state="verified"] .m-grin { display:block; }

  .avatar[data-state="unverified"] { --halo:#ff8c00; }
  .avatar[data-state="unverified"] .m-flat { display:block; }
  .avatar[data-state="unverified"] .pupil { transform:translate(4px,-3px); }

  .avatar[data-state="unsupported"] { --halo:#9600ff; }
  .avatar[data-state="unsupported"] .m-o { display:block; }
  .avatar[data-state="unsupported"] .pupil { transform:translateX(-5px); }

  .avatar[data-state="failed"] { --halo:#ff0000; }
  .avatar[data-state="failed"] .m-frown { display:block; }
  .avatar[data-state="failed"] .eye { transform:scaleY(.7); }

  .avatar[data-state="error"] { --halo:#ff0028; }
  .avatar[data-state="error"] .halo { animation: av-blinkhalo 1s steps(1) infinite; }
  .avatar[data-state="error"] .eye { display:none; }
  .avatar[data-state="error"] .dizzy, .avatar[data-state="error"] .m-frown { display:block; }

  .avatar[data-state="off"] .halo { opacity:0; }
  .avatar[data-state="off"] .eye { transform:scaleY(.06); }
  .avatar[data-state="off"] .m-flat, .avatar[data-state="off"] .zzz { display:block; }
`;

export const AVATAR_JS = String.raw`
  // id -> head, features drawn behind the head (ears), features in front, where the eyes and mouth go.
  var AVATARS = {
    orb: { name: "Orb", eyes: [78, 122, 96, 11], my: 132,
      back: "",
      head: '<defs><radialGradient id="g-orb" cx="35%" cy="30%"><stop offset="0" stop-color="#e6efff"/><stop offset="1" stop-color="#6c8cff"/></radialGradient></defs><circle cx="100" cy="100" r="62" fill="url(#g-orb)"/>',
      front: "" },
    robot: { name: "Robot", eyes: [76, 124, 96, 12], my: 134,
      back: '<g class="ear"><rect x="96" y="22" width="8" height="20" rx="3" fill="#8794a6"/><circle cx="100" cy="20" r="7" fill="#ff8c00"/></g>',
      head: '<rect x="40" y="42" width="120" height="112" rx="26" fill="#cfd8e3" stroke="#8794a6" stroke-width="4"/><rect x="52" y="66" width="96" height="58" rx="16" fill="#eef3f8"/>',
      front: '<circle cx="46" cy="98" r="6" fill="#8794a6"/><circle cx="154" cy="98" r="6" fill="#8794a6"/>' },
    cat: { name: "Cat", eyes: [76, 124, 100, 11], my: 134,
      back: '<g class="ear"><path d="M48 70 L52 30 L86 52 Z" fill="#f2b36b"/><path d="M152 70 L148 30 L114 52 Z" fill="#f2b36b"/><path d="M56 62 L58 42 L76 54 Z" fill="#ffd9d9"/><path d="M144 62 L142 42 L124 54 Z" fill="#ffd9d9"/></g>',
      head: '<ellipse cx="100" cy="104" rx="62" ry="54" fill="#f2b36b"/>',
      front: '<path d="M96 116 L104 116 L100 122 Z" fill="#e58a8a"/><g stroke="#10161f" stroke-width="2" opacity=".6"><path d="M62 118 L36 112"/><path d="M62 124 L36 128"/><path d="M138 118 L164 112"/><path d="M138 124 L164 128"/></g>' },
    owl: { name: "Owl", eyes: [74, 126, 92, 17], my: 138,
      back: '<g class="ear"><path d="M52 64 L46 34 L82 52 Z" fill="#8b6f4e"/><path d="M148 64 L154 34 L118 52 Z" fill="#8b6f4e"/></g>',
      head: '<ellipse cx="100" cy="104" rx="64" ry="62" fill="#a88a64"/><circle cx="74" cy="92" r="27" fill="#f4ecd8"/><circle cx="126" cy="92" r="27" fill="#f4ecd8"/>',
      front: '<path d="M92 112 L108 112 L100 126 Z" fill="#e9a23b"/>' },
    fox: { name: "Fox", eyes: [76, 124, 98, 10], my: 138,
      back: '<g class="ear"><path d="M44 78 L46 28 L88 56 Z" fill="#e8742c"/><path d="M156 78 L154 28 L112 56 Z" fill="#e8742c"/><path d="M54 66 L55 44 L76 58 Z" fill="#2b1a10"/><path d="M146 66 L145 44 L124 58 Z" fill="#2b1a10"/></g>',
      head: '<path d="M38 88 Q100 40 162 88 Q150 156 100 166 Q50 156 38 88 Z" fill="#e8742c"/><path d="M62 118 Q100 96 138 118 Q124 160 100 166 Q76 160 62 118 Z" fill="#fff4e6"/>',
      front: '<circle cx="100" cy="128" r="6" fill="#2b1a10"/>' },
    ghost: { name: "Ghost", eyes: [78, 122, 92, 11], my: 128,
      back: "",
      head: '<path d="M44 108 Q44 38 100 38 Q156 38 156 108 L156 160 L138 148 L120 162 L100 148 L80 162 L62 148 L44 160 Z" fill="#f2f5fa" stroke="#c6cfdb" stroke-width="4"/>',
      front: '<ellipse cx="62" cy="116" rx="9" ry="5" fill="#ffb7c8" opacity=".7"/><ellipse cx="138" cy="116" rx="9" ry="5" fill="#ffb7c8" opacity=".7"/>' }
  };
  var AVATAR_ORDER = ["orb", "robot", "cat", "owl", "fox", "ghost"];

  function avatarSvg(id, state) {
    var d = AVATARS[id] || AVATARS.orb, x1 = d.eyes[0], x2 = d.eyes[1], ey = d.eyes[2], r = d.eyes[3], my = d.my;
    function eye(x) {
      return '<g class="eye"><ellipse cx="' + x + '" cy="' + ey + '" rx="' + r + '" ry="' + r + '" fill="#10161f"/>' +
        '<circle class="pupil" cx="' + x + '" cy="' + ey + '" r="' + (r * 0.38) + '" fill="#ffffff"/></g>';
    }
    function happy(x) { return '<path class="happy" d="M' + (x - r) + ' ' + (ey + 4) + ' Q' + x + ' ' + (ey - r - 2) + ' ' + (x + r) + ' ' + (ey + 4) + '"/>'; }
    function dizzy(x) { var a = r * 0.8; return '<path class="dizzy" d="M' + (x - a) + ' ' + (ey - a) + ' L' + (x + a) + ' ' + (ey + a) + ' M' + (x + a) + ' ' + (ey - a) + ' L' + (x - a) + ' ' + (ey + a) + '"/>'; }
    var mouths =
      '<path class="m m-smile" d="M86 ' + my + ' Q100 ' + (my + 12) + ' 114 ' + my + '"/>' +
      '<path class="m m-grin" d="M80 ' + my + ' Q100 ' + (my + 24) + ' 120 ' + my + '"/>' +
      '<path class="m m-flat" d="M88 ' + (my + 4) + ' L112 ' + (my + 4) + '"/>' +
      '<path class="m m-frown" d="M86 ' + (my + 10) + ' Q100 ' + (my - 4) + ' 114 ' + (my + 10) + '"/>' +
      '<ellipse class="m m-o" cx="100" cy="' + (my + 5) + '" rx="6" ry="8" style="fill:none"/>' +
      '<ellipse class="m m-talk" cx="100" cy="' + (my + 6) + '" rx="12" ry="9"/>';
    var extras =
      '<text class="zzz" x="150" y="52">z z Z</text>' +
      '<g class="dots"><circle cx="146" cy="44" r="4"/><circle cx="158" cy="34" r="5"/><circle cx="173" cy="22" r="6"/></g>';
    return '<svg class="avatar" viewBox="0 0 200 200" data-state="' + (state || "listening") + '" role="img" aria-label="' + d.name + '">' +
      '<circle class="halo halo-dash" cx="100" cy="100" r="92"/>' +
      d.back + d.head + d.front + eye(x1) + eye(x2) + happy(x1) + happy(x2) + dizzy(x1) + dizzy(x2) + mouths + extras + '</svg>';
  }
`;
