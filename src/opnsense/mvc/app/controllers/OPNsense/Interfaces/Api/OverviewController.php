<?php

/*
 * Copyright (C) 2023 Deciso B.V.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES,
 * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
 * AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
 * OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

namespace OPNsense\Interfaces\Api;

use OPNsense\Base\ApiControllerBase;
use OPNsense\Core\Backend;
use OPNsense\Core\Config;
use OPNsense\Core\Legacy;
use OPNsense\Firewall\Util;
use OPNsense\Routing\Gateways;
use OPNsense\Interface\Autoconf;

class OverviewController extends ApiControllerBase
{
    private static function translations()
    {
        return [
            'flags' => gettext('Flags'),
            'options' => gettext('Options'),
            'supported_media' => gettext('Supported Media'),
            'is_physical' => gettext('Physical'),
            'device' => gettext('Device'),
            'name' => gettext('Name'),
            'description' => gettext('Description'),
            'status' => gettext('Status'),
            'enabled' => gettext('Enabled'),
            'link_type' => gettext('IPv4 Link Type'),
            'link_typev6' => gettext('IPv6 Link Type'),
            'ipv4' => gettext('IPv4 Addresses'),
            'ipv6' => gettext('IPv6 Addresses'),
            'gateways' => gettext('Gateways'),
            'routes' => gettext('Routes'),
            'macaddr' => gettext('MAC Address'),
            'media' => gettext('Media'),
            'media_raw' => gettext('Media (Raw)'),
            'mediaopt' => gettext('Media Options'),
            'capabilities' => gettext('Capabilities'),
            'identifier' => gettext('Identifier'),
            'ipaddr' => gettext('IP Address'),
            'subnetbits' => gettext('Subnet Bits'),
            'statistics' => gettext('Statistics'),
            'driver' => gettext('Driver'),
            'index' => gettext('Index'),
            'promiscuous listeners' => gettext('Promiscuous Listeners'),
            'send queue length' => gettext('Send Queue Length'),
            'send queue max length' => gettext('Send Queue Max Length'),
            'send queue drops' => gettext('Send Queue Drops'),
            'type' => gettext('Type'),
            'address length' => gettext('Address Length'),
            'header length' => gettext('Header Length'),
            'link state' => gettext('Link State'),
            'datalen' => gettext('Data Length'),
            'metric' => gettext('Metric'),
            'line rate' => gettext('Line Rate'),
            'packets received' => gettext('Packets Received'),
            'input errors' => gettext('Input Errors'),
            'packets transmitted' => gettext('Packets Transmitted'),
            'output errors' => gettext('Output Errors'),
            'collisions' => gettext('Collisions'),
            'bytes received' => gettext('Bytes Received'),
            'bytes transmitted' => gettext('Bytes Transmitted'),
            'multicasts received' => gettext('Multicasts Received'),
            'multicasts transmitted' => gettext('Multicasts Transmitted'),
            'input queue drops' => gettext('Input Queue Drops'),
            'packets for unknown protocol' => gettext('Packets for Unknown Protocol'),
            'HW offload capabilities' => gettext('Hardware Offload Capabilities'),
            'uptime at attach or stat reset' => gettext('Uptime at Attach or Statistics Reset'),
            'laggoptions' => gettext('LAGG Options'),
            'lagghash' => gettext('LAGG Hash'),
            'laggproto' => gettext('LAGG Protocol'),
            'laggstatistics' => gettext('LAGG Statistics'),
            'groups' => gettext('Groups'),
            'active ports' => gettext('Active Ports'),
            'vlan' => gettext('VLAN details'),
            'vlan_tag' => gettext('VLAN Tag'),
            'ifctl.nameserver' => gettext('Dynamic nameserver received'),
            'ifctl.prefix'  => gettext('Dynamic IPv6 prefix received'),
            'ifctl.router'  => gettext('Dynamic router received'),
            'ifctl.searchdomain'  => gettext('Dynamic searchdomain received')
        ];
    }

    /**
     * The routing table as scripts/routes/show_routes.py -n json gives it.
     */
    private static function routes()
    {
        $result = [];
        $fieldnames = [];
        $proto = '';
        exec('/usr/bin/netstat -rWn', $lines);
        foreach ($lines as $line) {
            $fields = preg_split('/\s+/', trim($line), -1, PREG_SPLIT_NO_EMPTY);
            if (count($fields) == 1 && $fields[0] == 'Internet:') {
                $proto = 'ipv4';
            } elseif (count($fields) == 1 && $fields[0] == 'Internet6:') {
                $proto = 'ipv6';
            } elseif (count($fields) > 2 && $fields[0] == 'Destination' && $fields[1] == 'Gateway') {
                $fieldnames = array_map('strtolower', $fields);
            } elseif (count($fields) > 2) {
                $record = ['proto' => $proto];
                foreach ($fields as $i => $field) {
                    if (isset($fieldnames[$i])) {
                        $record[$fieldnames[$i]] = $field;
                    }
                }
                foreach ($fieldnames as $fieldname) {
                    $record[$fieldname] = $record[$fieldname] ?? '';
                }
                $result[] = $record;
            }
        }
        return $result;
    }

    /**
     * Primary addresses of every interface, as pluginctl -46 gives them.
     */
    private static function primaryAddresses($ifconfig_details)
    {
        global $config;

        $result = [];
        foreach (array_keys($config['interfaces'] ?? []) as $int) {
            if (empty($config['interfaces'][$int])) {
                continue;
            }
            $result[$int] = [];
            foreach (['inet' => '4', 'inet6' => '6'] as $family => $opt) {
                $raw = $opt === '4' ? interfaces_primary_address($int, $ifconfig_details) :
                    interfaces_primary_address6($int, $ifconfig_details);
                $result[$int][] = [
                    'address' => $raw[0],
                    'network' => $raw[1],
                    'bits' => $raw[2],
                    'device' => $raw[3],
                    'interface' => $int,
                    'family' => $family,
                ];
            }
        }
        return $result;
    }

    private function parseIfInfo($interface = null, $detailed = false)
    {
        $backend = new Backend();
        $gateways = new Gateways();
        $cfg = Config::getInstance()->object();
        $result = [];

        /* abbreviated information */
        /* polled by the dashboard: gathered here rather than by three scripts */
        Legacy::load(['config.inc', 'util.inc', 'interfaces.inc']);
        $details = legacy_interfaces_details();
        $ifinfo = $interface === null ? $details : legacy_interfaces_details($interface);
        $routes = self::routes();
        $ifaddr = self::primaryAddresses($details);

        /* detailed information */
        if ($detailed) {
            $stats = json_decode($backend->configdpRun('interface list stats', [$interface]), true);

            foreach ($ifinfo as $if => $info) {
                if ($interface !== null && $if !== $interface) {
                    continue;
                }

                $ifinfo[$if]['statistics'] = $interface !== null ? $stats : $stats[$if];
            }
        }

        /* map routes to interfaces */
        foreach ($routes as $route) {
            if (!empty($route['netif']) && !empty($ifinfo[$route['netif']])) {
                $ifinfo[$route['netif']]['routes'][] = $route['destination'];
            }
        }

        /* combine interfaces details with config */
        foreach ($cfg->interfaces->children() as $key => $node) {
            if (!empty((string)$node->if) && !empty($ifinfo[(string)$node->if])) {
                $props = [];
                foreach ($node->children() as $property) {
                    $props[$property->getName()] = (string)$property;
                }
                $ifinfo[(string)$node->if]['config'] = $props;
                $ifinfo[(string)$node->if]['config']['identifier'] = $key;
            }
        }

        /* format information */
        foreach ($ifinfo as $if => $details) {
            $tmp = $details;

            if ($if == 'pfsync0') {
                continue;
            }
            /* collect ifctl received properties for this interface */
            foreach (Autoconf::all($if) as $key => $value) {
                $tmp["ifctl.{$key}"] =  $value;
            }

            $tmp['status'] = (!empty($details['flags']) && in_array('up', $details['flags'])) ? 'up' : 'down';
            if (!empty($details['status'])) {
                if (!(in_array($details['status'], ['active', 'running']))) {
                    /* reflect current ifconfig status, such as 'no carrier' */
                    $tmp['status'] = $details['status'];
                }
            }

            if (empty($details['config'])) {
                $tmp['identifier'] = '';
                $tmp['description'] = gettext('Unassigned Interface');
                $result[] = $tmp;
                continue;
            }

            $config = $details['config'];

            $tmp['identifier'] = $config['identifier'];
            $tmp['description'] = !empty($config['descr']) ? $config['descr'] : strtoupper($config['identifier']);
            $tmp['enabled'] = !empty($config['enable']);
            $tmp['link_type'] = !empty($config['ipaddr']) ? $config['ipaddr'] : 'none';
            $tmp['link_typev6'] = !empty($config['ipaddrv6']) ? $config['ipaddrv6'] : 'none';
            foreach ([4, 6] as $primary) {
                $addr = $ifaddr[$config['identifier']][$primary != 4] ?? [];
                $tmp['addr' . $primary] = !empty($addr['address']) ?
                    "{$addr['address']}/{$addr['bits']}" : '';
            }
            foreach (['link_type', 'link_typev6'] as $linkType) {
                if (Util::isIpAddress($tmp[$linkType])) {
                    $tmp[$linkType] = 'static';
                }
            }

            /* parse IP configuration */
            unset($tmp['ipv4'], $tmp['ipv6']);
            foreach (['ipv4', 'ipv6'] as $ipproto) {
                if (!empty($details[$ipproto])) {
                    foreach ($details[$ipproto] as $ip) {
                        if (!empty($ip['ipaddr'])) {
                            $entry = [];
                            $entry['ipaddr'] = $ip['ipaddr'] . '/' . $ip['subnetbits'];

                            if (!empty($ip['vhid'])) {
                                $vhid = $ip['vhid'];
                                $entry['vhid'] = $vhid;

                                if (!empty($details['carp'])) {
                                    foreach ($details['carp'] as $carp) {
                                        if ($carp['vhid'] == $vhid) {
                                            $entry['status'] = $carp['status'];
                                            $entry['advbase'] = $carp['advbase'];
                                            $entry['advskew'] = $carp['advskew'];
                                            $entry['peer'] = $carp['peer'];
                                            $entry['peer6'] = $carp['peer6'];
                                        }
                                    }
                                }
                            }

                            $tmp[$ipproto][] = $entry;
                        }
                    }
                }
            }

            /* parse VLAN configuration */
            $tmp['vlan_tag'] = null;
            if (!empty($details['vlan']) && !empty($details['vlan']['tag'])) {
                $tmp['vlan_tag'] = $details['vlan']['tag'];
            }

            /* gateway(s) */
            $gatewayv4 =  $gateways->getInterfaceGateway($tmp['identifier'], 'inet');
            $gatewayv6 = $gateways->getInterfaceGateway($tmp['identifier'], 'inet6');
            $tmp['gateways'] = array_values(array_filter([$gatewayv4, $gatewayv6]));

            $result[] = $tmp;
        }

        return $result;
    }

    public function interfacesInfoAction($details = false)
    {
        $result = $this->parseIfInfo(null, $details);
        return $this->searchRecordsetBase(
            $result,
            ['status', 'description', 'device', 'link_type', 'ipv4', 'ipv6', 'gateways', 'vlan_tag', 'routes']
        );
    }

    public function getInterfaceAction($if = null)
    {
        $result = ["message" => "failed"];
        if ($if != null) {
            $ifinfo = $this->parseIfInfo($if, true)[0] ?? [];
            if (!empty($ifinfo)) {
                if (!empty($ifinfo['macaddr'])) {
                    $macs = json_decode((new Backend())->configdRun('interface list macdb'), true);
                    $mac_hi = strtoupper(substr(str_replace(':', '', $ifinfo['macaddr']), 0, 6));
                    if (array_key_exists($mac_hi, $macs)) {
                        $ifinfo['macaddr'] = $ifinfo['macaddr'] . ' - ' . $macs[$mac_hi];
                    }
                }

                /* move statistics one level up */
                if (isset($ifinfo['statistics'])) {
                    $stats = $ifinfo['statistics'];
                    unset($ifinfo['statistics']);

                    // keep parsed flags from $ifinfo
                    unset($stats['flags']);

                    $ifinfo = array_merge($ifinfo, $stats);
                }

                unset($ifinfo['config']);
                unset($ifinfo['carp']);

                /* apply translations */
                foreach ($ifinfo as $key => $value) {
                    $ifinfo[$key] = [
                        'value' => $value,
                        'translation' => self::translations()[$key] ?? $key
                    ];
                }

                $result['message'] = $ifinfo;
            }
        }

        return $result;
    }

    public function reloadInterfaceAction($identifier = null)
    {
        $result = ['message' => 'failed'];

        if (!$this->request->isPost()) {
            return $result;
        }

        if ($identifier != null) {
            $backend = new Backend();
            $result['message'] = $backend->configdpRun('interface reconfigure', [$identifier]);
        }

        return $result;
    }

    public function exportAction()
    {
        $this->response->setRawHeader('Content-Type: application/json');
        $this->response->setRawHeader('Content-Disposition: attachment; filename=ifconfig.json');
        echo json_encode($this->parseIfInfo(null, true));
    }
}
