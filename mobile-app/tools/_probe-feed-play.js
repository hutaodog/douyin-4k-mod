(function(){
  var vs=[].slice.call(document.querySelectorAll('video'));
  var out={url:location.href, n:vs.length, vids:vs.map(function(v){var r=v.getBoundingClientRect();return {sz:v.videoWidth+'x'+v.videoHeight, rect:Math.round(r.width)+'x'+Math.round(r.height), paused:v.paused, rs:v.readyState, src:(v.currentSrc||v.src||'').slice(0,50)};}), canvases:[].slice.call(document.querySelectorAll('canvas')).map(function(c){var r=c.getBoundingClientRect();return Math.round(r.width)+'x'+Math.round(r.height);}), imgs:[].slice.call(document.querySelectorAll('[class*="backgroundCover"] img, img[class*="cover"]')).slice(0,3).map(function(i){var r=i.getBoundingClientRect();return Math.round(r.width)+'x'+Math.round(r.height);})};
  return JSON.stringify(out);
})()
