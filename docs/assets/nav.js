/* Single source of truth for navigation. Add a page here and it appears in the sidebar, search, and prev/next links. */
(function(){
var ROOT=document.currentScript.getAttribute('data-root')||'';
var NAV=[
{g:'Start here',items:[
 ['index.html','Overview','what naimix is home welcome'],
 ['getting-started/installation.html','Installation','node nvm npm install build tools zenity docker'],
 ['getting-started/quick-start.html','Quick start','demo mock backend curl run dev'],
 ['concepts/how-it-works.html','How it works','request flow architecture gateway integration route app shared collection']]},
{g:'Guides',items:[
 ['guides/developer-console.html','Developer Console','ui console token workspace try it test'],
 ['guides/gateways.html','Gateways','json xml soap sql baseUrl wsdl commonParams headers'],
 ['guides/integrations.html','Integrations','input backend output mapping jsonpath transform'],
 ['guides/apps-and-routes.html','Apps & Routes','bff public path method mount basePath'],
 ['guides/authentication.html','Caller authentication','login basicLogin oauth2 ldap session token bearer'],
 ['guides/crud-generation.html','Generated CRUD endpoints','database tables stored procedures bulk'],
 ['guides/transform-functions.html','Transform functions','custom function postProcess typescript'],
 ['guides/export.html','OpenAPI & MCP export','swagger openapi mcp claude']]},
{g:'Tutorials',items:[
 ['tutorials/index.html','Video tutorials','video watch screencast'],
 ['tutorials/xml-gateway.html','Create an XML gateway','xml gateway video']]},
{g:'Deploying',items:[
 ['deployment/workspace.html','Workspace & Git','configDir settings git checkout'],
 ['deployment/qa-production.html','QA & Production','build:qa build:prod data plane deployment.yaml'],
 ['deployment/ops-console.html','Ops Console','ops token monitoring system env']]},
{g:'Reference',items:[
 ['reference/config-reference.html','Config file reference','yaml schema fields types'],
 ['reference/environment-variables.html','Environment variables','env dotenv port config_dir console_token ops_token'],
 ['reference/http-api.html','HTTP API','healthz __endpoints auth login console api'],
 ['reference/troubleshooting.html','Troubleshooting','error fix better-sqlite3 esbuild eaddrinuse 401 503'],
 ['reference/limitations.html','Known limitations','roadmap saml sessions memory']]}
];
var flat=[];NAV.forEach(function(s){s.items.forEach(function(i){flat.push(i)})});
var here=location.pathname.replace(/\\/g,'/');
function isHere(p){return here.slice(-p.length)===p||(p==='index.html'&&/\/docs\/?$/.test(here))}
var cur=-1;flat.forEach(function(i,n){if(isHere(i[0])&&(cur<0||i[0].length>flat[cur][0].length))cur=n});
// shell
var art=document.querySelector('article');
var ic=document.createElement('link');ic.rel='icon';ic.type='image/svg+xml';ic.href=ROOT+'assets/logo.svg';document.head.appendChild(ic);
var shell='<header class="topbar"><button id="menu-btn" class="btn" aria-label="Menu">☰</button><a class="brand" href="'+ROOT+'index.html"><img src="'+ROOT+'assets/logo.svg" alt="" width="26" height="26" style="vertical-align:-6px;margin-right:8px">nai<span>mix</span> docs</a><span class="sp"></span><input id="search" type="search" placeholder="Search docs…" autocomplete="off"><button id="theme" class="btn" title="Toggle theme">◐</button></header><div class="layout"><nav id="sidebar"></nav><main></main></div>';
var content=art.outerHTML;document.body.innerHTML=shell;
var main=document.querySelector('main');main.innerHTML=content+'<aside id="toc"></aside>';
art=main.querySelector('article');
// sidebar
var sb=document.getElementById('sidebar'),h='';
NAV.forEach(function(s){h+='<h4>'+s.g+'</h4>';s.items.forEach(function(i){h+='<a href="'+ROOT+i[0]+'" data-k="'+(i[1]+' '+i[2]).toLowerCase()+'"'+(flat[cur]===i?' class="active"':'')+'>'+i[1]+'</a>'})});
sb.innerHTML=h;
var act=sb.querySelector('.active');if(act&&act.scrollIntoView)act.scrollIntoView({block:'center'});
// search: filters sidebar by title/keywords, Enter opens first match
var q=document.getElementById('search');
q.addEventListener('input',function(){var v=q.value.trim().toLowerCase(),words=v.split(/\s+/).filter(Boolean);
 sb.querySelectorAll('a').forEach(function(a){var k=a.getAttribute('data-k');a.classList.toggle('hidden',words.length>0&&!words.every(function(w){return k.indexOf(w)>-1}))});
 sb.querySelectorAll('h4').forEach(function(h4){var n=h4.nextElementSibling,any=false;while(n&&n.tagName==='A'){if(!n.classList.contains('hidden'))any=true;n=n.nextElementSibling}h4.classList.toggle('hidden',!any)})});
q.addEventListener('keydown',function(e){if(e.key==='Enter'){var a=sb.querySelector('a:not(.hidden)');if(a)location.href=a.href}});
document.addEventListener('keydown',function(e){if(e.key==='/'&&document.activeElement!==q&&!/input|textarea/i.test(document.activeElement.tagName)){e.preventDefault();q.focus()}});
// theme + menu
var root=document.documentElement,t=null;try{t=localStorage.getItem('nx-theme')}catch(e){}if(t)root.setAttribute('data-theme',t);
document.getElementById('theme').onclick=function(){var dark=root.getAttribute('data-theme')?root.getAttribute('data-theme')==='dark':matchMedia('(prefers-color-scheme:dark)').matches;var n=dark?'light':'dark';root.setAttribute('data-theme',n);try{localStorage.setItem('nx-theme',n)}catch(e){}};
document.getElementById('menu-btn').onclick=function(){sb.classList.toggle('open')};
// page title + prev/next
var title=art.querySelector('h1');document.title=(title?title.textContent+' · ':'')+'naimix docs';
if(cur>=0){var p=flat[cur-1],n=flat[cur+1],pg='<div class="pager"><span>'+(p?'<a href="'+ROOT+p[0]+'"><small>← Previous</small>'+p[1]+'</a>':'')+'</span><span>'+(n?'<a href="'+ROOT+n[0]+'" style="text-align:right;display:block"><small>Next →</small>'+n[1]+'</a>':'')+'</span></div>';art.insertAdjacentHTML('beforeend',pg)}
// toc
var toc=document.getElementById('toc'),th='<b>On this page</b>';
art.querySelectorAll('h2,h3').forEach(function(h,i){if(!h.id)h.id=h.textContent.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||('s'+i);th+='<a class="'+(h.tagName==='H3'?'sub':'')+'" href="#'+h.id+'">'+h.textContent+'</a>'});
toc.innerHTML=th;if(!art.querySelector('h2'))toc.style.display='none';
// copy buttons
art.querySelectorAll('pre').forEach(function(pre){var b=document.createElement('button');b.className='btn copy';b.textContent='Copy';b.onclick=function(){var c=pre.querySelector('code');navigator.clipboard&&navigator.clipboard.writeText((c||pre).innerText).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1200)})};pre.appendChild(b)});
// videos: <figure class="video" data-src="videos/x.mp4" data-poster="images/x.png" data-title="…">
art.querySelectorAll('figure.video').forEach(function(f){
 var src=ROOT+f.getAttribute('data-src'),poster=f.getAttribute('data-poster'),cap=f.getAttribute('data-title')||'',vtt=f.getAttribute('data-captions');
 var v=document.createElement('video');v.controls=true;v.preload='metadata';v.playsInline=true;if(poster)v.poster=ROOT+poster;
 var s=document.createElement('source');s.src=src;s.type='video/mp4';v.appendChild(s);
 if(vtt){var tr=document.createElement('track');tr.kind='captions';tr.src=ROOT+vtt;tr.srclang='en';tr.label='English';tr.default=false;v.appendChild(tr)}
 var failed=function(){var d=document.createElement('div');d.className='vph';d.innerHTML='<b>Video not added yet</b>Drop a screen recording at <code>docs/'+f.getAttribute('data-src')+'</code> and reload this page — it will appear here automatically.';f.replaceChild(d,v)};
 s.addEventListener('error',failed);
 f.insertBefore(v,f.firstChild);
 var fc=document.createElement('figcaption');fc.textContent='▶ '+cap;f.appendChild(fc)});
})();
