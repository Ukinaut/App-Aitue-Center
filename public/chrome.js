// Identidad visual compartida con el index de Tienda-Aitue-Espa-a.
const svg = (path) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const symbols = {
  inicio:'m3 10 9-7 9 7v10H3z M9 20v-7h6v7',
  apps:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  usuarios:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M18 7v6 M15 10h6',
  roles:'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z M8 12l3 3 5-6',
  alertas:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
  sistema:'M3 4h18v12H3z M8 21h8 M12 16v5 M6 8h4 M6 12h8',
  actividad:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',
  logout:'M9 21H5V3h4 M9 12h12 M16 7l5 5-5 5',
  mail:'M3 5h18v14H3z m0 0 9 8 9-8',
  login:'M15 3h5v18h-5 M3 12h12 M10 7l5 5-5 5',
};
export const logo = (footer = false) => `<img src="/brand/logo-${footer?'footer':'nav'}.png" alt="AITUE" class="brand-logo-img" width="120" height="60">`;
const esc = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {sistema:'Estado del sistema',alertas:'Centro de alertas',inicio:'Inicio',apps:'Aplicaciones',usuarios:'Usuarios y accesos',roles:'Roles y permisos',actividad:'Actividad'};
function navItem(id, user, view, footer = false) {
  const label = labels[id];
  const content = footer ? `${label}<span class="footer-link-arrow" aria-hidden="true">→</span>` : `${svg(symbols[id])}${id==='apps'?'<span>Aplicaciones</span>':''}`;
  if (!user) return `<a class="${footer?'footer-link':`hud-nav-link ${id==='apps'?'hud-nav-featured':''}`}" href="${id==='roles'?'#estructura':id==='inicio'?'#inicio':'#acceso'}" title="${label}" aria-label="${label}">${content}</a>`;
  return `<button type="button" data-view="${id}" class="${footer?'footer-link':`hud-nav-link ${id==='apps'?'hud-nav-featured':''} ${view===id?'active':''}`}" title="${label}" aria-label="${label}" ${!footer&&view===id?'aria-current="page"':''}>${content}</button>`;
}
export function header(user = null, view = 'inicio') {
  return `<header class="hud-header"><div class="header-waves" aria-hidden="true"></div><div class="header-container"><a class="header-brand" href="/" aria-label="AITUE, inicio">${logo()}</a><nav class="hud-nav-wrap" aria-label="Navegación principal"><div class="hud-nav-list">${['inicio','apps',...(user?['usuarios']:[]),'roles',...(user?['alertas','actividad']:[]),...(user?.role==='superadmin'?['sistema']:[])].map(id=>navItem(id,user,view)).join('')}<a class="hud-nav-link-external" href="#contacto">Contacto</a></div><div class="hud-auth-group">${user?`<span class="btn-nav-profile" title="${esc(user.email)}">${svg(symbols.usuarios)}<span>${esc(user.name)}</span></span><button id="logout" type="button" class="btn-nav-logout" title="Cerrar sesión" aria-label="Cerrar sesión">${svg(symbols.logout)}</button>`:`<button type="button" class="btn-nav-login" data-open-access aria-haspopup="dialog">${svg(symbols.login)}<span>Acceder</span></button><span class="btn-nav-register">${svg(symbols.roles)}<span>Portal AITUE</span></span>`}</div></nav></div></header>`;
}
export function footer(user = null, view = 'inicio') {
  return `<footer class="corporate-footer" id="contacto"><div class="footer-waves" aria-hidden="true"><i></i><i></i><i></i></div><div class="footer-container"><div class="footer-grid"><div class="footer-col-brand"><a class="footer-brand" href="/" aria-label="AITUE, inicio">${logo(true)}</a><p class="footer-about-text">Un solo acceso a las aplicaciones de AITUE. Conectamos equipos, herramientas y permisos en un espacio de trabajo compartido.</p><a class="footer-cta-btn" href="mailto:comercial@aitue.net">${svg(symbols.mail)} Contactar con nosotros</a></div><div><h2 class="footer-col-title">Portal AITUE</h2><ul class="footer-links-list">${['inicio','apps',...(user?['alertas','actividad']:[]),...(user?.role==='superadmin'?['sistema']:[])].map(id=>`<li>${navItem(id,user,view,true)}</li>`).join('')}</ul></div><div><h2 class="footer-col-title">Acceso y equipo</h2><ul class="footer-links-list">${(user?['usuarios','roles']:['roles']).map(id=>`<li>${navItem(id,user,view,true)}</li>`).join('')}${!user?'<li><a class="footer-link" href="#acceso">Ingresar al portal<span class="footer-link-arrow" aria-hidden="true">→</span></a></li>':''}<li><a class="footer-link" href="mailto:comercial@aitue.net">Soporte y consultas<span class="footer-link-arrow" aria-hidden="true">→</span></a></li></ul></div><div><h2 class="footer-col-title">Contacto directo</h2><div class="footer-contact-item"><span class="footer-contact-badge tel-badge">TEL</span><a href="tel:08003452488">Atención al Cliente</a></div><div class="footer-contact-item"><span class="footer-contact-badge wsp-badge">WSP</span><a href="https://wa.me/5491154565634" target="_blank" rel="noopener noreferrer">WhatsApp Directo</a></div><div class="footer-contact-item"><span class="footer-contact-badge email-badge">EMAIL</span><a href="mailto:comercial@aitue.net">comercial@aitue.net</a></div><div class="footer-contact-item"><span class="footer-contact-badge dir-badge">SEDE</span><span>Alicante / Comunidad Valenciana — España<br>Cobertura Peninsular y UE</span></div></div></div><div class="footer-bottom"><div class="footer-bottom-info"><p>© ${new Date().getFullYear()} AITUE COMUNICA S.A. Todos los derechos reservados.</p><p>Portal central de aplicaciones · Acceso por roles y permisos.</p></div><div class="footer-bottom-status">${svg(symbols.roles)}<span>ACCESO CENTRALIZADO</span></div><div class="footer-social-wrap">
          <!-- Facebook -->
          <a href="https://www.facebook.com/aitue.net" target="_blank" rel="noopener noreferrer" class="social-btn facebook" aria-label="Facebook">
            <svg viewBox="0 0 24 24" class="social-icon" fill="currentColor">
              <path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c4.56-.93 8-4.96 8-9.75z" />
            </svg>
            <span class="social-name">Facebook</span>
          </a>
          <!-- Instagram -->
          <a href="https://www.instagram.com/aituecomunica/" target="_blank" rel="noopener noreferrer" class="social-btn instagram" aria-label="Instagram">
            <svg viewBox="0 0 24 24" class="social-icon" fill="currentColor">
              <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.051.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
            </svg>
            <span class="social-name">Instagram</span>
          </a>
          <!-- LinkedIn -->
          <a href="https://www.linkedin.com/company/aitue/" target="_blank" rel="noopener noreferrer" class="social-btn linkedin" aria-label="LinkedIn">
            <svg viewBox="0 0 24 24" class="social-icon" fill="currentColor">
              <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
            </svg>
            <span class="social-name">LinkedIn</span>
          </a>
          <!-- YouTube -->
          <a href="https://www.youtube.com/@Aitue-TIENDA" target="_blank" rel="noopener noreferrer" class="social-btn youtube" aria-label="YouTube">
            <svg viewBox="0 0 24 24" class="social-icon" fill="currentColor">
              <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.518 3.545 12 3.545 12 3.545s-7.518 0-9.388.508a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11C4.482 20.455 12 20.455 12 20.455s7.518 0 9.388-.508a3.003 3.003 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
            </svg>
            <span class="social-name">YouTube</span>
          </a>
          <!-- TikTok -->
          <a href="https://www.tiktok.com/@aitue.movil" target="_blank" rel="noopener noreferrer" class="social-btn tiktok" aria-label="TikTok">
            <svg viewBox="0 0 24 24" class="social-icon" fill="currentColor">
              <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.06-2.89-.52-4.06-1.39v7.94c0 1.93-.66 3.86-1.95 5.25-1.54 1.67-3.92 2.62-6.23 2.4-2.86-.18-5.59-2.12-6.53-4.83-.98-2.73-.25-6.07 1.83-8.08 1.43-1.4 3.49-2.15 5.51-2.02.01 1.34 0 2.68.01 4.02-1.22-.05-2.52.28-3.39 1.17-.98.98-1.12 2.64-.34 3.79.79 1.22 2.4 1.74 3.78 1.34 1.13-.3 1.95-1.33 2.13-2.48.06-1.18.02-2.38.03-3.57V0h.07z" />
            </svg>
            <span class="social-name">TikTok</span>
          </a>
        </div></div></div></footer>`;
}
