(function(){
  'use strict';
  const clean=u=>{try{const x=new URL(u);return x.origin+x.pathname;}catch(e){return '';}};
  const params=new URLSearchParams(location.search);
  let first;
  try{first=JSON.parse(sessionStorage.getItem('clear_crm_source'));}catch(e){}
  if(!first){
    first={landing_page:clean(location.href),referrer:document.referrer?new URL(document.referrer).origin:'',source:'Direct / unknown'};
    for(const k of ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'])first[k]=(params.get(k)||'').slice(0,500);
    if(first.utm_source)first.source=first.utm_source;else if(first.referrer){const host=new URL(first.referrer).hostname;first.source=/(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com)$/.test(host)?'Organic search':host;}
    try{sessionStorage.setItem('clear_crm_source',JSON.stringify(first));}catch(e){}
  }
  const fill=()=>document.querySelectorAll('input[name="clear_tracking"]').forEach(el=>{el.value=JSON.stringify({...first,submission_page:clean(location.href)});});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fill);else fill();
  document.addEventListener('submit',fill,true);
})();
