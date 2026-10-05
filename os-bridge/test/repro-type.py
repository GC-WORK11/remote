import sys, os, time, subprocess, argparse, importlib.util

spec = importlib.util.spec_from_file_location(
    "cc", os.path.join(os.path.dirname(os.path.abspath(__file__)), "computer-correctness.py"))
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)

args = argparse.Namespace(
    bin=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "daemon", "omprd")),
    omp_bin=os.path.abspath(os.path.join(os.path.dirname(__file__), "fake-omp.sh")),
    port=8795, display=":99")

rig = cc.Rig(args)
try:
    tok = rig.pair()
    ws = rig.connect(tok)
    p, wid = cc.spawn_xev(":99")
    print("xev wid", wid)
    ok = cc.focus_window(":99", wid)
    print("focused", ok)
    cc.drain_xev(p)
    r = cc.send_actions(ws, [{"action": "type", "text": "hello", "delayMs": 0}], [])
    print("type reply:", r)
    evts = cc.xev_events(p, settle=1.0)
    print("n events:", len(evts), evts[:12])
    print("active now:", cc.xcmd(["xdotool", "getactivewindow"], ":99").stdout.strip())
    cc.drain_xev(p)
    r = cc.send_actions(ws, [{"action": "type", "text": "world", "delayMs": 5}], [])
    print("type2 reply:", r)
    evts = cc.xev_events(p, settle=1.0)
    print("n events2:", len(evts), evts[:16])
    cc.drain_xev(p)
    r = cc.send_actions(ws, [{"action": "click", "x": 300, "y": 250}], [])
    print("click reply:", r)
    evts = cc.xev_events(p, settle=1.0)
    print("click events:", evts[:12])
    # how does the daemon inject? check the key path it took + xev again slowly
    r = cc.send_actions(ws, [{"action": "key", "key": "a"}], [])
    print("key reply:", r)
    evts = cc.xev_events(p, settle=1.0)
    print("key events:", evts[:12])
    p.terminate()
    ws.close()
finally:
    rig.stop()
