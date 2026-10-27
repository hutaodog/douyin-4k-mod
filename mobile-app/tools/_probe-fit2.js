(function(){
  var m=document.querySelector('meta[name=viewport]');
  var before={meta:m.content, sw:document.documentElement.scrollWidth, bsw:document.body.scrollWidth, iw:innerWidth};
  m.setAttribute('content','width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover');
  var natural=Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth);
  var scale=innerWidth/natural;
  return JSON.stringify({before:before, afterReset:{sw:document.documentElement.scrollWidth, bsw:document.body.scrollWidth}, natural:natural, scale:scale});
})()
