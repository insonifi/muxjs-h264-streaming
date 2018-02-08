function fnv32a(str, type) {
	var hval = 0;
	var i = 0;
	var c;
	var getByte = type == 'bytearray' ?
	 function (x) { return str[x]; } :
	 function (x) { return str.charCodeAt(x); };

	while (c = getByte(i)) {
		hval ^= c;
		i += 1;
		hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
	}

	return hval;
}
