(function(){
  var root=document.getElementById('root');
  var child=root&&root.firstElementChild;
  var out={
    url:location.href,
    iw:innerWidth,
    bodySW:document.body.scrollWidth,
    deSW:document.documentElement.scrollWidth,
    rootZoom: root? root.style.zoom : null,
    childCls: child? String(child.className).slice(0,40) : null,
    childZoom: child? child.style.zoom : null,
    childW: child? Math.round(child.getBoundingClientRect().width) : null,
    childSW: child? child.scrollWidth : null,
    overflowX: getComputedStyle(document.body).overflowX
  };
  return JSON.stringify(out);
})()
