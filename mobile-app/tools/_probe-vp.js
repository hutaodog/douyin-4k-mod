(function(){
  var out = {
    url: location.href,
    bodyText: (document.body.innerText || '').replace(/\s+/g,' ').slice(0,120),
    playerContainers: document.querySelectorAll('[class*=playerContainer],[class*=basePlayer]').length,
    xg: document.querySelectorAll('xg-video-container,xgplayer').length,
    renderData: !!document.getElementById('RENDER_DATA'),
    rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    bodyChildren: document.body.children.length,
    firstClasses: [].slice.call(document.body.children).map(function(e){return e.tagName + '.' + String(e.className).slice(0,28)}).slice(0,8)
  };
  return JSON.stringify(out);
})()
