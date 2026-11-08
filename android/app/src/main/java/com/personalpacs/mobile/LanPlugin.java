package com.personalpacs.mobile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Finds Personal PACS on the local network: lists the phone's own IPv4 networks (Wi-Fi, hotspot)
 * and asks every one of them "where is the PC?" with a UDP broadcast. The PC answers with its port.
 */
@CapacitorPlugin(name = "Lan")
public class LanPlugin extends Plugin {

    private static List<InterfaceAddress> ipv4Addresses() {
        List<InterfaceAddress> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getAddress() instanceof Inet4Address) out.add(ia);
                }
            }
        } catch (Exception ignored) {}
        return out;
    }

    private static String nameOf(InterfaceAddress ia) {
        try {
            NetworkInterface ni = NetworkInterface.getByInetAddress(ia.getAddress());
            return ni == null ? "" : ni.getName();
        } catch (Exception e) {
            return "";
        }
    }

    @PluginMethod
    public void interfaces(PluginCall call) {
        JSArray list = new JSArray();
        for (InterfaceAddress ia : ipv4Addresses()) {
            JSObject o = new JSObject();
            o.put("name", nameOf(ia));
            o.put("address", ia.getAddress().getHostAddress());
            o.put("prefix", (int) ia.getNetworkPrefixLength());
            if (ia.getBroadcast() != null) o.put("broadcast", ia.getBroadcast().getHostAddress());
            list.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("interfaces", list);
        call.resolve(ret);
    }

    @PluginMethod
    public void discover(final PluginCall call) {
        final String message = call.getString("message", "PPACS-DISCOVER");
        final int port = call.getInt("port", 47821);
        final int timeoutMs = Math.max(200, Math.min(10000, call.getInt("timeoutMs", 1500)));
        new Thread(() -> {
            JSArray replies = new JSArray();
            DatagramSocket sock = null;
            try {
                sock = new DatagramSocket();
                sock.setBroadcast(true);
                sock.setSoTimeout(200);
                byte[] data = message.getBytes(StandardCharsets.UTF_8);
                List<InetAddress> targets = new ArrayList<>();
                for (InterfaceAddress ia : ipv4Addresses()) {
                    if (ia.getBroadcast() != null) targets.add(ia.getBroadcast());
                }
                targets.add(InetAddress.getByName("255.255.255.255"));
                for (InetAddress t : targets) {
                    try {
                        sock.send(new DatagramPacket(data, data.length, t, port));
                    } catch (Exception ignored) {}
                }
                long end = System.currentTimeMillis() + timeoutMs;
                byte[] buf = new byte[512];
                Set<String> seen = new HashSet<>();
                while (System.currentTimeMillis() < end) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    try {
                        sock.receive(p);
                    } catch (SocketTimeoutException e) {
                        continue;
                    }
                    String text = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                    String from = p.getAddress().getHostAddress();
                    if (seen.add(from + "|" + text)) {
                        JSObject o = new JSObject();
                        o.put("address", from);
                        o.put("message", text);
                        replies.put(o);
                    }
                }
            } catch (Exception ignored) {
                // Return whatever was found.
            } finally {
                if (sock != null) sock.close();
            }
            JSObject ret = new JSObject();
            ret.put("replies", replies);
            call.resolve(ret);
        }).start();
    }
}
