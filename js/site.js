(function(){
  'use strict';
  const nav = document.querySelector('.nav');
  if(nav){
    const wrap = nav.querySelector('.wrap');
    const links = nav.querySelector('.nav-links');
    if(wrap && links && !nav.querySelector('.nav-toggle')){
      const btn = document.createElement('button');
      btn.className='nav-toggle'; btn.type='button'; btn.setAttribute('aria-expanded','false'); btn.setAttribute('aria-label','Open navigation');
      btn.innerHTML='<span></span><span></span><span></span>';
      wrap.appendChild(btn);
      btn.addEventListener('click',()=>{
        const open = nav.classList.toggle('nav-open');
        btn.setAttribute('aria-expanded', String(open));
        btn.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      });
      links.addEventListener('click',(e)=>{ if(e.target.closest('a')){ nav.classList.remove('nav-open'); btn.setAttribute('aria-expanded','false'); }});
    }
  }

  const reveals = document.querySelectorAll('.reveal, .feat-cell, .rstep, .panel, .stat-card');
  if('IntersectionObserver' in window){
    const io = new IntersectionObserver(entries=>entries.forEach(entry=>{
      if(entry.isIntersecting){ entry.target.classList.add('is-visible'); io.unobserve(entry.target); }
    }),{threshold:.08});
    reveals.forEach((el,i)=>{ el.style.setProperty('--reveal-delay', `${Math.min(i*35,280)}ms`); io.observe(el); });
  } else reveals.forEach(el=>el.classList.add('is-visible'));

  document.querySelectorAll('[data-count]').forEach(el=>{
    const target = Number(el.dataset.count); if(!Number.isFinite(target)) return;
    const suffix = el.dataset.suffix || '';
    let started=false;
    const animate=()=>{
      if(started) return; started=true; const start=performance.now(), duration=850;
      const tick=(now)=>{ const p=Math.min(1,(now-start)/duration), eased=1-Math.pow(1-p,3); el.textContent=Math.round(target*eased).toLocaleString()+suffix; if(p<1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    };
    if('IntersectionObserver' in window){ const o=new IntersectionObserver(es=>{if(es[0].isIntersecting){animate();o.disconnect();}},{threshold:.6});o.observe(el); } else animate();
  });

  document.querySelectorAll('.faq-item').forEach(item=>{
    const q=item.querySelector('.faq-q');
    if(!q) return;
    q.addEventListener('click',()=>{
      const open=item.classList.toggle('open');
      q.setAttribute('aria-expanded',String(open));
    });
  });
})();
