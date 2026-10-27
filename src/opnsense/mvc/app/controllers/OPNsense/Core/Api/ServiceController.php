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

namespace OPNsense\Core\Api;

use OPNsense\Base\ApiControllerBase;
use OPNsense\Core\Backend;
use OPNsense\Core\Legacy;

/**
 * Class SessionsController
 * @package OPNsense\IPsec\Api
 */
class ServiceController extends ApiControllerBase
{
    /**
     * The status message service_message() gives, with the checks it makes
     * through pgrep answered from one process list for all services.
     * @param array $service service as plugins_services() returns it
     * @param array $procs pid => [name, seconds running]
     * @return string
     */
    private static function serviceMessage($service, $procs)
    {
        $pid = '';
        if (!empty($service['nocheck'])) {
            $status = true;
        } elseif (isset($service['pidfile'])) {
            /* pgrep -nF: the pid in the file is a live process */
            $content = file_exists($service['pidfile']) ? trim(@file_get_contents($service['pidfile']) ?? '') : '';
            $status = isset($procs[(int)strtok($content, "\n")]);
            if ($status) {
                $pid = ' as pid ' . $content;
            }
        } else {
            /* pgrep -anx: the newest process of exactly this name */
            $newest = null;
            foreach ($procs as $p => $proc) {
                if ($proc[0] === $service['name'] && ($newest === null || $proc[1] < $procs[$newest][1])) {
                    $newest = $p;
                }
            }
            $status = $newest !== null;
            if ($status) {
                $pid = ' as pid ' . $newest;
            }
        }

        return sprintf('%s is %s.', service_name($service), $status ? 'running' . $pid : 'not running');
    }

    /**
     * Search service entries
     * @return array
     */
    public function searchAction()
    {
        /* polled by the dashboard: as pluginctl -S, without starting it */
        Legacy::load(['config.inc', 'util.inc', 'system.inc', 'interfaces.inc', 'filter.inc', 'auth.inc']);
        $procs = [];
        exec('/bin/ps -ax -o pid= -o etimes= -o comm=', $lines);
        foreach ($lines as $line) {
            $fields = preg_split('/\s+/', trim($line), 3);
            if (count($fields) == 3) {
                $procs[(int)$fields[0]] = [$fields[2], (int)$fields[1]];
            }
        }
        $data = [];
        foreach (plugins_services() as $service) {
            if (!empty($service['noshow'])) {
                continue;
            }
            $service['status'] = self::serviceMessage($service, $procs);
            $data[] = $service;
        }
        $records = [];

        if (!empty($data)) {
            foreach ($data as $service) {
                $record = [
                    'id' => $service['name'] . (array_key_exists('id', $service) ? '/' . $service['id'] : ''),
                    'locked' => !empty($service['locked']) || !empty($service['nocheck']) ? 1 : 0,
                    'running' => strpos($service['status'], 'is running') !== false ? 1 : 0,
                    'description' => gettext($service['description']),
                    'name' => $service['name'],
                ];
                $records[] = $record;
            }
        }

        return $this->searchRecordsetBase($records);
    }

    /**
     * start a service
     * @param string $name to identify the service
     * @param string $id to identify the service instance
     * @return array
     */
    public function startAction($name, $id = '')
    {
        if (!$this->request->isPost()) {
            return ['result' => 'failed'];
        }

        (new Backend())->configdpRun('service start', [$name, $id]);

        return ['result' => 'ok'];
    }

    /**
     * restart a service
     * @param string $name to identify the service
     * @param string $id to identify the service instance
     * @return array
     */
    public function restartAction($name, $id = '')
    {
        if (!$this->request->isPost()) {
            return ['result' => 'failed'];
        }

        (new Backend())->configdpRun('service restart', [$name, $id]);

        return ['result' => 'ok'];
    }

    /**
     * stop a service
     * @param string $name to identify the service
     * @param string $id to identify the service instance
     * @return array
     */
    public function stopAction($name, $id = '')
    {
        if (!$this->request->isPost()) {
            return ['result' => 'failed'];
        }

        (new Backend())->configdpRun('service stop', [$name, $id]);

        return ['result' => 'ok'];
    }
}
