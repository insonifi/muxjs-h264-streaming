var img = document.getElementById('frame');
var tsDiv = document.getElementById('ts');
var infoDiv = document.getElementById('info');
var players = {};
var initSegment = muxjs.mp4.generator.initSegment;
var w = new Worker('wrk.js');

//Log.setLogLevel(Log.debug);

w.addEventListener('message', function (e) {
  var id = e.data.id;
  var player = players[id];

  if (!player) {
    // init player
    players[id] = {
      dom: document.createElement('video'),
      mse: new MediaSource(),
      inited: false,
      temp: [],
      pushBuffer: Function.prototype,
      box: new MP4Box(),
      pos: 0,
      mime: '',
      timeout: -1,
    };
    player = players[id];

    // setup player

    document.body.appendChild(player.dom);
    player.dom.src = URL.createObjectURL(player.mse);
    player.pushBuffer = pushBuffer.bind(null, player);
    player.remove = function () {
      player.mse.endOfStream();
      player.dom.stop();
      console.log(player.mse.readyState);
      /*
      if (player.vBuf) {
        player.mse.removeSourceBuffer(player.vBuf);
        player.vBuf = undefined;
        console.log('remove buffer %i', id);
      }
      */
    };

    player.mse.addEventListener('sourceopen', function () {
      player.dom.play();
      player.pushBuffer();
    });
      player.box.onReady = function (info) {
        var mime = 'video/mp4; codecs="'
          + info.tracks.map(function (t) { return t.codec; })
          + '"'
        ;

        player.inited = true;
        player.mime = mime;
      };
  }
  if (!player.inited) {
    var buffer = e.data.boxes;

    buffer.fileStart = player.pos;
    player.pos += buffer.byteLength;
    player.box.appendBuffer(buffer);
  }
  player.temp.push(e.data);
  clearTimeout(player.timeout);
  player.timeout = setTimeout(player.remove, 3e3);
});

function pushBuffer(player) {
  var data = player.temp.shift();

  if (!data) {
    setTimeout(player.pushBuffer, 100);

    return;
  }

  var track = data.track;
  var boxes = data.boxes;

  if (player.dom.error) {
    console.log(player.dom.error);

    return;
  }
  if (!player.vBuf && track.type == 'raw') {
    player.vBuf = player.mse.addSourceBuffer(player.mime);
    player.vBuf.mode = 'sequence';
    player.vBuf.addEventListener('update', player.pushBuffer);
    console.log(player.mime);
  }
  if (!player.vBuf && track.sps) {
    //RFC 6381
    var mime = 'video/mp4; codecs="avc1.'
      + hexPadded(track.profileIdc)
      + hexPadded(track.profileCompatibility)
      + hexPadded(track.levelIdc)
      + '"'
    ;
    var mimeA = 'audio/mp3';

    player.vBuf = player.mse.addSourceBuffer(mime);
    player.vBuf.mode = 'sequence';
    player.vBuf.addEventListener('update', player.pushBuffer);
    if (!MediaSource.isTypeSupported(mimeA)) {
      mimeA = 'audio/mpeg';
    }
    player.aBuf = player.mse.addSourceBuffer(mimeA);
    player.aBuf.mode = 'sequence';
    player.aBuf.addEventListener('update', player.pushBuffer);
    console.log(mime, mimeA);
  }


  //Consume data
  if (track.type == 'video' && !player.inited && player.vBuf) {
    var buffer;
    var init = initSegment([track]);

    buffer = new Uint8Array(init.byteLength + boxes.byteLength);
    buffer.set(init);
    buffer.set(boxes, init.byteLength);
    player.inited = true;
    player.dom.play();
  }
  if ((track.type == 'video' || track.type == 'raw') && player.inited) {
    player.vBuf.appendBuffer(boxes);
  }
  if (track.type == 'audio' && player.aBuf) {
    player.aBuf.appendBuffer(boxes);
  }
};

function hexPadded(n) {
  return ('00' + n.toString(16)).slice(-2);
}

function waitForUpdate(args) {
  var srcBuf = args[0];

  if (srcBuf.updating) {
    return new Promise(function (resolve, reject) {
      const handleUpdate = function handleUpdate() {
        srcBuf.removeEventListener('update', handleUpdate);
        resolve(args);
      }

      srcBuf.addEventListener('update', handleUpdate);
    });
  } else {
    return Promise.resolve(args);
  }
}
