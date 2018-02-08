package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"

	"github.com/Comcast/gots/packet"
	"github.com/Comcast/gots/pes"
	"github.com/Comcast/gots/psi"
	"github.com/gorilla/websocket"
)

const (
	CONTAINER    = "m2ts"
	STREAM_COUNT = 1
	DATAGRAM_SZ  = 64 * (1 << 10)
	BASEPORT     = 6660
	BUFF_SZ      = 1 * (1 << 20)
	VIDEO        = 0x01
	AUDIO        = 0x01
	RAW          = 0xFF
	PROTO        = "udp"
)

var upgrader = websocket.Upgrader{}
var broadcast = make([]*websocket.Conn, 0)
var count = flag.Int("ports", STREAM_COUNT, "Number of ports to listen to")
var fport = flag.Int("fport", BASEPORT, "First port to listen")
var proto = flag.String("proto", PROTO, "Protocol to use [udp, tcp]")
var container = flag.String("container",
	CONTAINER,
	"Expected container [m2ts, mp4]",
)

type listenerFunc func(string, connHandler)
type dataHandler func(string, chan []byte, net.Conn)
type connHandler func(net.Conn)
type streams map[int8]uint16

func video(w http.ResponseWriter, r *http.Request) {
	log.Println("WebSocket connection")
	wsc, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Print("Upgrade: ", err)
		return
	}
	//defer wsc.Close()
	broadcast = append(broadcast, wsc)
	wsc.SetCloseHandler(func(code int, text string) error {
		wsc.Close()
		return nil
	})
	addr, _ := net.ResolveTCPAddr("tcp4", "127.0.0.1:4433")
	sink, err := net.DialTCP("tcp4", nil, addr)

	if err != nil {
		return
	}
	for {
		_, message, err := wsc.ReadMessage()
		if err != nil {
			break
		}
		_, nerr := sink.Write(message)
		if nerr != nil {
			break
		}
	}
}

func get_prog_pids(pkt []byte) (uint16, error) {
	buffer := bytes.NewBuffer(pkt)
	pat, err := psi.ReadPAT(buffer)
	if err != nil {
		return 0, err
	}
	programmes := pat.ProgramMap()
	//log.Println("programmes", programmes)
	for _, prog_pid := range programmes {
		return prog_pid, nil
	}
	return 0, errors.New("No programmes found")
}

func get_es_pids(pkt []byte, prog_id uint16) (streams, error) {
	buffer := bytes.NewBuffer(pkt)
	pmt, err := psi.ReadPMT(buffer, prog_id)
	if err != nil {
		return nil, err
	}
	streams := make(streams)
	var stream_type int8
	for _, stream := range pmt.ElementaryStreams() {
		if stream.IsVideoContent() {
			stream_type = VIDEO
		} else {
			stream_type = AUDIO
		}
		streams[stream_type] = stream.ElementaryPid()
	}
	return streams, nil
}

func handleTSData(id string, ch chan []byte, c net.Conn) {
	log.Println("new connection")
	defer c.Close()
	pkt := make([]byte, packet.PacketSize)
	pts := make([]byte, 8)
	id_len := byte(len(id))
	prefix := append([]byte{id_len}, []byte(id)...)
	reader := bufio.NewReader(c)
	sync := false
	es_pids := make(streams)
	var pkt_type int8 = -1
	var last_pts, pts_n uint64
	var prog_pid uint16

	for {
		if !sync {
			offset, err := packet.Sync(reader)
			if err != nil && offset == 0 {
				continue
			}
			reader.Discard(int(offset))
			//make sure we start with SyncByte (GST sync)
			peek, _ := reader.Peek(1)
			if peek[0] != packet.SyncByte {
				continue
			}
			sync = true
			log.Println("synced at", offset)
		}
		_, err := io.ReadFull(reader, pkt)
		if err != nil {
			log.Println(err)
			break
		}
		pid_n, _ := packet.Pid(pkt)
		if pid_n == 0 {
			//handle PAT
			prog_pid, err = get_prog_pids(pkt)
			if err != nil {
				log.Println(err)
				continue
			}
			continue
		}
		if prog_pid != 0 && pid_n == prog_pid {
			//handle PMT
			es_pids, err = get_es_pids(pkt, prog_pid)
			if err != nil {
				log.Println(err)
				continue
			}
			continue
		}

		for es_type, es_pid := range es_pids {
			if es_pid == pid_n {
				pkt_type = es_type
				break
			}
		}
		if pkt_type == -1 && len(es_pids) > 0 {
			log.Println("unknown type")
			continue
		}

		// Push payload
		has_payload, err := packet.ContainsPayload(pkt)
		if !has_payload || err != nil {
			log.Println("no payload")
			continue
		}

		payload, err := packet.Payload(pkt)
		if err != nil {
			log.Println("can't get payload")
			continue
		}

		start, err := packet.PayloadUnitStartIndicator(pkt)
		if has_payload && start {
			// PES
			pes_bytes, err := packet.PESHeader(pkt)
			if err != nil {
				pts_n = 0
			} else {
				pes_hdr, _ := pes.NewPESHeader(pes_bytes)
				pts_n = pes_hdr.PTS()
				payload = pes_hdr.Data()
			}
			if pts_n == 0 {
				pts_n = last_pts + 1
			}
			last_pts = pts_n
		}

		binary.LittleEndian.PutUint64(pts, pts_n)

		suffix := append(pts, byte(pkt_type))
		hdr := append(prefix, suffix...)
		// len_id|id|pts|type|payload
		ch <- append(hdr, payload...)
	}
}

func handleMP4Data(id string, ch chan []byte, c net.Conn) {
	log.Println("new connection")
	defer c.Close()
	pkt := make([]byte, DATAGRAM_SZ)
	pts := make([]byte, 8)
	id_len := byte(len(id))
	prefix := append([]byte{id_len}, []byte(id)...)
	pkt_type := RAW

	for {
		n, err := c.Read(pkt)
		if err != nil {
			break
		}
		payload := pkt[:n]

		suffix := append(pts, byte(pkt_type))
		hdr := append(prefix, suffix...)
		// len_id|id|pts|type|payload
		ch <- append(hdr, payload...)
	}
}

func listenTcp(port string, handler connHandler) {
	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Print("listen: ", err)
	}
	log.Println("listen:", listener.Addr().String())
	for {
		c, err := listener.Accept()
		if err != nil {
			log.Println("listen:", err)
			continue
		}
		handler(c)
	}
}

func listenUdp(port string, handler connHandler) {
	addr, err := net.ResolveUDPAddr("udp", ":"+port)
	if err != nil {
		log.Print("resolve: ", err)
	}
	c, err := net.ListenUDP("udp", addr)
	if err != nil {
		log.Print("listen: ", err)
	}
	log.Println("listen:", c.LocalAddr().String())
	handler(c)
}

func listen(proto string, port string, listener connHandler) {
	switch proto {
	case "udp":
		listenUdp(port, listener)
	case "tcp":
		listenTcp(port, listener)
	default:
	}
}

func wrapHandler(
	id string,
	datachan chan []byte,
	handler dataHandler,
) connHandler {
	return func(c net.Conn) {
		handler(id, datachan, c)
	}
}

func publish(ch chan []byte) {
	for data := range ch {
		for _, wsc := range broadcast {
			wsc.WriteMessage(websocket.BinaryMessage, data)
		}
	}
}

func main() {
	flag.Parse()
	var handleData dataHandler
	datachan := make(chan []byte)
	http.HandleFunc("/video", video)
	http.Handle("/", http.FileServer(http.Dir(".")))

	switch *container {
	case "m2ts":
		handleData = handleTSData
	case "mp4":
		handleData = handleMP4Data
	default:
		fmt.Printf("Can't handle %s\n", *container)
		return
	}

	for num := 0; num < *count; num++ {
		go listen(
			*proto,
			fmt.Sprintf("%d", *fport+num),
			wrapHandler(
				fmt.Sprintf("Stream %d", num),
				datachan,
				handleData,
			),
		)
	}

	go publish(datachan)
	log.Fatal(http.ListenAndServe(":9999", nil))
	close(datachan)
}
