#!/usr/local/bin/python3

"""
    Copyright (c) 2026 SinceVIC20
    All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are met:

    1. Redistributions of source code must retain the above copyright notice,
     this list of conditions and the following disclaimer.

    2. Redistributions in binary form must reproduce the above copyright
     notice, this list of conditions and the following disclaimer in the
     documentation and/or other materials provided with the distribution.

    THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES,
    INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
    AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
    AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
    OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
    SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
    INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
    CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
    ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
    POSSIBILITY OF SUCH DAMAGE.

    --------------------------------------------------------------------------------------
    Print every interface's traffic counters as one JSON line, now and then
    every <interval> seconds, with the names legacy_interface_stats() uses.
    One process for a whole traffic stream instead of ifinfo every second.
"""
import ctypes
import json
import os
import sys
import time

AF_LINK = 18


class sockaddr(ctypes.Structure):
    _fields_ = [('sa_len', ctypes.c_uint8), ('sa_family', ctypes.c_uint8)]


class if_data(ctypes.Structure):
    # struct if_data from net/if.h, up to the counters used here
    _fields_ = [
        ('ifi_type', ctypes.c_uint8), ('ifi_physical', ctypes.c_uint8),
        ('ifi_addrlen', ctypes.c_uint8), ('ifi_hdrlen', ctypes.c_uint8),
        ('ifi_link_state', ctypes.c_uint8), ('ifi_vhid', ctypes.c_uint8),
        ('ifi_datalen', ctypes.c_uint16), ('ifi_mtu', ctypes.c_uint32),
        ('ifi_metric', ctypes.c_uint32), ('ifi_baudrate', ctypes.c_uint64),
        ('ifi_ipackets', ctypes.c_uint64), ('ifi_ierrors', ctypes.c_uint64),
        ('ifi_opackets', ctypes.c_uint64), ('ifi_oerrors', ctypes.c_uint64),
        ('ifi_collisions', ctypes.c_uint64), ('ifi_ibytes', ctypes.c_uint64),
        ('ifi_obytes', ctypes.c_uint64),
    ]


class ifaddrs(ctypes.Structure):
    pass


ifaddrs._fields_ = [
    ('ifa_next', ctypes.POINTER(ifaddrs)), ('ifa_name', ctypes.c_char_p),
    ('ifa_flags', ctypes.c_uint), ('ifa_addr', ctypes.POINTER(sockaddr)),
    ('ifa_netmask', ctypes.POINTER(sockaddr)), ('ifa_dstaddr', ctypes.POINTER(sockaddr)),
    ('ifa_data', ctypes.c_void_p),
]

# by name: ctypes.util.find_library() would run the C compiler to find it
libc = ctypes.CDLL('libc.so.7', use_errno=True)
libc.getifaddrs.argtypes = [ctypes.POINTER(ctypes.POINTER(ifaddrs))]
libc.freeifaddrs.argtypes = [ctypes.POINTER(ifaddrs)]


def counters():
    result = {}
    head = ctypes.POINTER(ifaddrs)()
    if libc.getifaddrs(ctypes.byref(head)) != 0:
        return result
    try:
        ifa = head
        while ifa:
            item = ifa.contents
            if item.ifa_addr and item.ifa_addr.contents.sa_family == AF_LINK and item.ifa_data:
                data = ctypes.cast(item.ifa_data, ctypes.POINTER(if_data)).contents
                result[item.ifa_name.decode()] = {
                    'packets received': data.ifi_ipackets,
                    'input errors': data.ifi_ierrors,
                    'packets transmitted': data.ifi_opackets,
                    'output errors': data.ifi_oerrors,
                    'collisions': data.ifi_collisions,
                    'bytes received': data.ifi_ibytes,
                    'bytes transmitted': data.ifi_obytes,
                }
            ifa = item.ifa_next
    finally:
        libc.freeifaddrs(head)
    return result


if __name__ == '__main__':
    interval = max(float(sys.argv[1]) if len(sys.argv) > 1 else 1.0, 1.0)
    while True:
        try:
            print(json.dumps(counters()), flush=True)
        except BrokenPipeError:
            # the reader went away; stop without a second error on exit
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
            sys.exit(0)
        time.sleep(interval)
