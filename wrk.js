importScripts('mux.js');
importScripts('fnv.js');
importScripts('rdr.js');
var ws = new WebSocket('ws://' + location.host+ '/video');
var pipe = {};
var queue = [];
var readers = new Readers(4);

var idLen = 1;
var tsLen = 8;
var tLen = 1;
var tsStart;
var A = 0.05;
var LITTLE_ENDIAN = true;
var tsLast = 0;
var getTrackInfo = function (pid) {
  switch (pid) {
    case 0x00:
      return {type: 'video', id: 1};
    case 0x01:
      return {type: 'audio', id: 1};
    case 0xFF:
      return {type: 'raw', id: 1};
  }
};
var push = self.postMessage.bind(self);

readers.on('data', handleLoad);
ws.binaryType = 'arraybuffer';
ws.addEventListener('message', handleLoad);


function handleLoad(e) {
  // idLen|idBytes|tsBytes|typeBytes|dataBytes
  var resultDv = new DataView(e.data);
  var idByteLen = resultDv.getUint8(0, LITTLE_ENDIAN);
  var id = fnv32a(
		new Uint8Array(e.data.slice(idLen, idLen + idByteLen)), 
		'bytearray'
	);
  var pts = resultDv.getUint32(idLen + idByteLen, LITTLE_ENDIAN);
  var pid = resultDv.getUint8(idLen + idByteLen + tsLen, LITTLE_ENDIAN);
  var trackInfo = getTrackInfo(pid);
  var payload = e.data.slice(idLen + idByteLen + tLen + tsLen);

  if (!pipe[id]) {
    initPipe(id);
  }
  switch (trackInfo.type) {
    case 'video':
      setTimeout(pipe[id].h264.push, 0, {
        data: payload,
        pts: pts,
        dts: pts,
        trackId: trackInfo.id,
        type: trackInfo.type,
      }); 
      break;
    case 'audio':
      /*
      pipe[id].mp3.push({
        data: payload,
        pts: pts,
        dts: pts,
        trackId: trackInfo.id,
        type: 'audio',
      });
      */
      //console.log('A%c %s', 'color: blue', payload.slice(0, 30).toString());
      //ws.send(payload);

      //self.postMessage({id: id, track: {type: 'audio'}, boxes: payload});
      /*
      var temp = new Uint8Array(pipe[id].audio.byteLength + payload.byteLength);

      temp.set(pipe[id].audio);
      temp.set(payload, pipe[id].audio.byteLength);
      pipe[id].audio = temp;
      */
      setTimeout(pipe[id].pushAQ, 0, {
        boxes: payload,
        pts: pts,
      });
      break;
    case 'raw':
      push({ id: id, track: {type: 'raw'}, boxes: payload }, [payload]);
      break;
    default:
      break;
  }
};

function initPipe(id) {
  pipe[id] = {
    audioQ: [],
    pushAQ: Function.prototype,
    h264: new muxjs.codecs.h264.H264Stream(),
    adts: new muxjs.codecs.adts(),
    mp3: new muxjs.codecs.mp3(),
    //coalesce: new muxjs.mp4.CoalesceStream({remux: true}),
    audioSegment: new muxjs.mp4.AudioSegmentStream({
      codec: 'adts',
      type: 'audio',
      timelineStartInfo: {
        baseMediaDecodeTime: 0
      }
    }),
    videoSegment: new muxjs.mp4.VideoSegmentLive({
      id: 1,
      codec: 'avc',
      durationMs: 10000,
      type: 'video',
      pts: 0,
      //samplerate: 1000,
      timelineStartInfo: {
        baseMediaDecodeTime: 0
      }
    })

  };
  pipe[id].pushAQ = Array.prototype.push.bind(pipe[id].audioQ);
  pipe[id].h264.pipe(pipe[id].videoSegment);
  pipe[id].videoSegment.on('data', function (data) {
    var audioSegment;
    var audioSegmentByteLen = 0;
    var count = 0;
    var seg;
    var offset = 0;

    data.id = id;
    //pipe[id].audioSegment.flush();
    self.postMessage(data, [data.boxes.buffer]);

    /** flush audio */
    while (pipe[id].audioQ[count]
      && pipe[id].audioQ[count].pts < data.track.maxSegmentPts) {
      audioSegmentByteLen += pipe[id].audioQ[count].boxes.byteLength;
      count += 1;
    }
    if (!count) {
      return;
    }
    audioSegment = new Uint8Array(audioSegmentByteLen);
    for (var i = 0; i < count; i += 1) {
      seg = pipe[id].audioQ.shift().boxes;
      audioSegment.set(seg, offset);
      offset += seg.byteLength;
    }
    self.postMessage({
      id: id, track: {type: 'audio'}, boxes: audioSegment
    }, [audioSegment.buffer]);
  });
  /*
  pipe[id].audioSegment.on('data', function (data) {
    data.id = id;
    self.postMessage(data, [data.boxes.buffer]);
  });

  */
  /*
  pipe[id].mp3.on('data', function (data) {
    data.id = id;
    data.boxes = new Uint8Array(data.data);
    data.track = {type: 'audio'};
    pipe[id].audioQ.push(data);
    //self.postMessage(data, [data.boxes.buffer]);
  });
  */
}
