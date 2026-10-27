(function(){
  var out = {danmu: [], containers: []};
  var nodes = document.querySelectorAll('[class*="danmu"],[class*="Danmu"],[class*="danMu"]');
  for (var i=0;i<nodes.length && out.danmu.length<8;i++){
    var e=nodes[i], r=e.getBoundingClientRect(), cs=getComputedStyle(e);
    out.danmu.push({cls:String(e.className).slice(0,40), rect:Math.round(r.left)+','+Math.round(r.top)+' '+Math.round(r.width)+'x'+Math.round(r.height), fs:cs.fontSize, pos:cs.position, z:cs.zIndex});
  }
  // 播放器容器位置
  var v=document.querySelector('video');
  if(v){var r=v.getBoundingClientRect(); out.video=Math.round(r.left)+','+Math.round(r.top)+' '+Math.round(r.width)+'x'+Math.round(r.height);}
  return JSON.stringify(out);
})()
