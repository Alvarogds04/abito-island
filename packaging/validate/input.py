"""Validator-owned XTest client. Never imported/linked by the application."""
import ctypes as C
import os
import sys

if not os.environ.get('DISPLAY', '').startswith(':') or os.environ['DISPLAY'].split('.')[0] == ':0':
    raise SystemExit('private nonzero DISPLAY required')
x = C.CDLL('libX11.so.6')
t = C.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes = [C.c_char_p]
x.XOpenDisplay.restype = C.c_void_p
x.XCloseDisplay.argtypes = [C.c_void_p]
x.XSync.argtypes = [C.c_void_p, C.c_int]
t.XTestFakeMotionEvent.argtypes = [C.c_void_p, C.c_int, C.c_int, C.c_int, C.c_ulong]
t.XTestFakeButtonEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
display = x.XOpenDisplay(None)
if not display:
    raise SystemExit('cannot open private display')
try:
    px, py = map(int, sys.argv[1:3])
    if not t.XTestFakeMotionEvent(display, -1, px, py, 0):
        raise SystemExit('XTest motion failed')
    for pressed in [1, 0]:
        if not t.XTestFakeButtonEvent(display, 1, pressed, 0):
            raise SystemExit('XTest click failed')
    x.XSync(display, 0)
finally:
    x.XCloseDisplay(display)
