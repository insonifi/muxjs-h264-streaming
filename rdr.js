function Readers(count) {
  var handlers = {};
  var readers = [];
  var free = [];
  var queue = [];

  /** Private methods */
  var trigger = function (key) {
    var args = Array.prototype.slice.call(arguments, 1);

    handlers[key].apply(null, args);
  };
  var next = function (_e) {
    var e = _e;

    if (!e && queue.length > 0) {
      e = queue.shift();
    }
    if (!e) {
      return;
    }
    var frId = free.shift()
    var fr = readers[frId];

    fr.readAsArrayBuffer(e.data);
  };
  var handleLoad = function (e) {
    trigger('data', e);
    free.push(e.target.id);
    next();
  };
  var addReader = function () {
    var fr = new FileReader();

    fr.addEventListener('load', handleLoad);
    fr.id = readers.length;
    readers.push(fr);
    free.push(fr.id);
  };
  this.push = function (e) {
    var i;
    var fr;

    if (free.length) {
      next(e);
    } else {
      queue.push(e);
    }
  };

  this.on = function (key, fn) {
    handlers[key] = fn;
  };

  /** Add initial reader */
  for (var i = 0; i < count; i += 1) {
    addReader();
  }
}
