<?php

/*
 * Copyright (C) 2026 SinceVIC20
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

namespace OPNsense\Core;

/**
 * Run legacy code in the web server's PHP worker, which already has PHP and
 * its extensions loaded, instead of having configd start a PHP process for
 * a few milliseconds of work.  Only for read-only work a page polls.
 */
class Legacy
{
    /**
     * Load legacy include files.  They set these globals at file level, which
     * would otherwise land in this method's scope.
     * @param array $files include files, as legacy scripts name them
     */
    public static function load(array $files)
    {
        global $config, $timezone, $groupindex, $userindex;

        foreach ($files as $file) {
            require_once $file;
        }
    }

    /**
     * Run a legacy script and return what it prints, as configd would.
     * @param string $script full path of the script
     * @param array $includes include files to load first
     * @return string
     */
    public static function run($script, array $includes = ['config.inc'])
    {
        self::load($includes);
        ob_start();
        try {
            (static function () use ($script) {
                global $config, $timezone, $groupindex, $userindex;
                include $script;
            })();
        } finally {
            $output = ob_get_clean();
        }
        return $output;
    }
}
