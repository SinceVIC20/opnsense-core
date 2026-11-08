/*
 * Copyright (C) 2024 Deciso B.V.
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

export default class Traffic extends BaseWidget {
    constructor(config) {
        super(config);

        this.charts = {
            trafficIn: null,
            trafficOut: null
        };
        this.initialized = null;
        this.datasets = {inbytes: [], outbytes: []};
        this.configurable = true;
        this.configChanged = false;
        // one full-height graph, or the separate in and out graphs
        this.graph = null;
        this.linkSpeeds = {};
        this.linkSpeed = 1e9;
        this.scale = 'auto';
        this.top = 1e4;
        // where the linear axis is drawn now, gliding toward top
        this.shownTop = this.top;
        this.glideAt = null;
        // each interface's auto scale top
        this.tracks = {};
        this.selected = ['wan'];
        // the rates the header shows, read off the graph at its reference line
        this.headerParts = null;
        this.headerKey = null;
        this.order = [];
        // interfaces left out of the row
        this.hidden = [];
        try {
            const selected = JSON.parse(window.localStorage.getItem('opnsense.widget.traffic.graph'));
            if (Array.isArray(selected) && selected.length > 0) {
                this.selected = [selected[0]];
            }
            const order = JSON.parse(window.localStorage.getItem('opnsense.widget.traffic.order'));
            if (Array.isArray(order)) {
                this.order = order;
            }
            const hidden = JSON.parse(window.localStorage.getItem('opnsense.widget.traffic.hidden'));
            if (Array.isArray(hidden)) {
                this.hidden = hidden;
            }
            if (JSON.parse(window.localStorage.getItem('opnsense.widget.traffic.scale')) === 'log') {
                this.scale = 'log';
            }
        } catch (e) { /* storage unavailable: show WAN, in the configured order */ }
        this.view = 'graph';
        try {
            if (window.localStorage.getItem('opnsense.widget.traffic.view') === 'original') {
                this.view = 'original';
            }
        } catch (e) { /* storage unavailable: use the default */ }
    }

    _set_alpha(color, opacity) {
        const op = Math.round(Math.min(Math.max(opacity || 1, 0), 1) * 255);
        return color + op.toString(16).toUpperCase();
    }

    _chartConfig(dataset) {
        return {
            type: 'line',
            data: {
                datasets: dataset
            },
            options: {
                bezierCurve: false,
                maintainAspectRatio: false,
                scaleShowLabels: false,
                tooltipEvents: [],
                pointDot: true,
                scaleShowGridLines: true,
                responsive: true,
                normalized: true,
                elements: {
                    line: {
                        fill: true,
                        cubicInterpolationMode: 'monotone',
                        clip: 0
                    }
                },
                scales: {
                    x: {
                        display: false,
                        time: {
                            tooltipFormat:'HH:mm:ss',
                            unit: 'second',
                            stepSize: 10,
                            minUnit: 'second',
                            displayFormats: {
                                second: 'HH:mm:ss',
                                minute: 'HH:mm:ss'
                            }
                        },
                        type: 'realtime',
                        realtime: {
                            duration: 20000,
                            delay: 2000,
                        },
                    },
                    y: {
                        ticks: {
                            callback: (value, index, values) => {
                                return this._formatBits(value);
                            }
                        }
                    }
                },
                hover: {
                    mode: 'nearest',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        mode: 'nearest',
                        intersect: false,
                        callbacks: {
                            label: (context) => {
                                return context.dataset.label + ": " + this._formatBits(context.dataset.data[context.dataIndex].y).toString();
                            }
                        }
                      },
                    streaming: {
                        frameRate: 30,
                        ttl: 30000
                    },
                    colorschemes: {
                        scheme: 'tableau.Classic10'
                    }
                }
            },
        };
    }

    /* The one graph: the selected interface's in and out, shaded like the
     * separate graphs, on one scale they share: fitted to the traffic, or
     * logarithmic from 1 kb/s to the link speed, where light traffic stays
     * visible beside heavy. */
    _graphConfig() {
        return {
            type: 'line',
            data: {
                datasets: []
            },
            // close the graph on the right with a line like the axis on the left
            plugins: [{
                // A line down the graph at a fifth of its width, under the gap
                // between the header's in and out: they show the rates where it
                // crosses the curves.
                id: 'trafficReference',
                afterDraw: (chart) => {
                    const down = $('.traffic-header-in');
                    const area = chart.chartArea;
                    const canvas = chart.canvas.getBoundingClientRect();
                    const x = Math.round(area.left + (area.right - area.left) * 0.2) + 0.5;
                    // the names refill their pages when the graph's width changed
                    if (this.view === 'graph' && this.rowData && Math.round(area.right - area.left) !== this.listFor) {
                        this._graphButtons(this.rowData, this.page);
                    }
                    if (this.view === 'graph') {
                        this._placeHeader(canvas.left + x - 0.5);
                    }
                    if (this.view !== 'graph' || down.length === 0 || !down.is(':visible') || x < area.left || x > area.right) {
                        this._referenceAbove(null);
                        return;
                    }
                    const y = chart.scales.y;
                    this._referenceAbove({x: canvas.left + x - 0.5, top: down[0].getBoundingClientRect(),
                        row: $('.traffic-graph-legend')[0].getBoundingClientRect(), bottom: canvas.top + area.top,
                        color: y.options.border.color});
                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.strokeStyle = y.options.border.color;
                    ctx.lineWidth = y.options.border.width;
                    ctx.beginPath();
                    ctx.moveTo(x, area.top);
                    ctx.lineTo(x, area.bottom);
                    ctx.stroke();
                    // a dot on each curve where the line crosses it, in its colour,
                    // and the rate read back off the scale at the dot's height
                    let values = {};
                    chart.data.datasets.forEach((dataset, index) => {
                        const at = dataset.hidden ? null : this._curveAt(chart.getDatasetMeta(index).data, x);
                        if (at !== null) {
                            ctx.fillStyle = dataset.dotColor;
                            ctx.beginPath();
                            // in to the left of the line and out to the right, their centres 0.618 of a dot
                            // apart (the golden ratio), so both show
                            ctx.arc(x + (dataset.src_field === 'inbytes' ? -2.47 : 2.47), at, 4, 0, 2 * Math.PI);
                            ctx.fill();
                            const value = Math.max(0, y.getValueForPixel(at));
                            // under 2 Kb the log scale's floor hides the height: the measured
                            // rate there instead, between the samples either side
                            values[dataset.src_field] = value < 2000 ?
                                this._rateAt(dataset.data, chart.scales.x.getValueForPixel(x)) ?? value : value;
                        }
                    });
                    ctx.restore();
                    // the header reads the dots, a few times a second so it stays legible
                    const now = Date.now();
                    if (now - (this.headerTime ?? 0) >= 250) {
                        this.headerTime = now;
                        this._headerValues(['inbytes', 'outbytes'].map(dir =>
                            values[dir] !== undefined ? this._rateParts(values[dir]) : ['', '']));
                    }
                }
            }, {
                // the Lin/Log button sits in the scale, a fixed distance above its bottom line
                id: 'trafficScaleSwitch',
                afterDraw: (chart) => {
                    const y = chart.scales.y;
                    const button = $('.traffic-scale-switch');
                    // hidden, it has no size to centre by: wait until it can be measured
                    if (y.ticks.length < 1 || button.length === 0 || !button.is(':visible')) {
                        return;
                    }
                    const middle = y.getPixelForValue(y.ticks[0].value) - 31;
                    // the graph redraws 30 times a second: touch the page only on a change
                    const place = `${this.scale} ${Math.round(middle)} ${Math.round(chart.chartArea.left)}`;
                    if (place === this.switchPlace) {
                        return;
                    }
                    this.switchPlace = place;
                    button.text(this.scale === 'log' ? 'Log' : 'Lin');
                    button.css({
                        'top': `${middle - button.outerHeight() / 2}px`,
                        'left': `${chart.chartArea.left / 2 - button.outerWidth() / 2 + 3}px`
                    });
                }
            }, {
                id: 'trafficRightEdge',
                afterDraw: (chart) => {
                    const y = chart.scales.y;
                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.strokeStyle = y.options.border.color;
                    ctx.lineWidth = y.options.border.width;
                    ctx.beginPath();
                    ctx.moveTo(chart.chartArea.right, chart.chartArea.top);
                    ctx.lineTo(chart.chartArea.right, chart.chartArea.bottom);
                    ctx.stroke();
                    ctx.restore();
                }
            }],
            options: {
                layout: {
                    // the same room between the widget's edges and the scale or right line
                    padding: {
                        left: 12,
                        right: 12
                    }
                },
                maintainAspectRatio: false,
                responsive: true,
                normalized: true,
                elements: {
                    line: {
                        borderWidth: 2,
                        cubicInterpolationMode: 'monotone',
                        clip: 0
                    },
                    point: {
                        radius: 0
                    }
                },
                scales: {
                    x: {
                        display: false,
                        type: 'realtime',
                        realtime: {
                            duration: 20000,
                            delay: 2000,
                            pause: this.view !== 'graph'
                        },
                    },
                    y: this._yScale()
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    // the rates are on the interface names; no box following the cursor
                    tooltip: {
                        enabled: false
                    },
                    streaming: {
                        frameRate: 30,
                        ttl: 30000
                    },
                    // it would paint over the green and orange set below
                    colorschemes: false,
                    // both shadings under both lines, so neither line is tinted
                    filler: {
                        drawTime: 'beforeDatasetsDraw'
                    }
                }
            },
        };
    }

    /* Lines for every interface, so one shows its recent traffic as soon as
     * it is selected. */
    _graphDatasets(data) {
        let datasets = [];
        Object.keys(data.interfaces).forEach((intf) => {
            for (const dir of ['inbytes', 'outbytes']) {
                datasets.push({
                    label: `${data.interfaces[intf].name} ${dir === 'inbytes' ? '\u2193' : '\u2191'}`,
                    // in in the Connections widget's green, out in the separate graphs'
                    // orange, both shaded, the green faintly so it doesn't drown out,
                    // its line a little see-through under the orange
                    borderColor: dir === 'inbytes' ? this._set_alpha('#5E9C4A', 0.75) : '#F28E2B',
                    dotColor: dir === 'inbytes' ? '#5E9C4A' : '#F28E2B',
                    backgroundColor: this._set_alpha(dir === 'inbytes' ? '#5E9C4A' : '#F28E2B', dir === 'inbytes' ? 0.09 : 0.15),
                    // to the floor of the log scale, to 0 on the other
                    fill: this.scale === 'log' ? 'start' : 'origin',
                    // out over in, the lower order drawn last; the dots stack the same
                    order: dir === 'inbytes' ? 1 : 0,
                    hidden: !this.selected.includes(intf),
                    intf: intf,
                    last_time: data.time,
                    src_field: dir,
                    data: [],
                });
            }
        });
        return datasets;
    }

    _isCnx(intf) {
        return intf === 'cnx_hw' || intf === 'cnx_cpu';
    }

    /* The WAN's traffic split into what the hardware forwarded and what the
     * CPU handled, as two more interfaces ahead of the others, where the
     * stream has it. */
    _withOffload(data) {
        if (data.offload !== undefined) {
            data.interfaces = {
                cnx_hw: {...data.offload.hw, name: this.translations.cnxhw},
                cnx_cpu: {...data.offload.cpu, name: this.translations.cnxcpu},
                ...data.interfaces
            };
        }
        return data;
    }

    /* The selected interface's link speed, for the top of the scale. */
    _graphScale() {
        this.linkSpeed = this._linkSpeed(this.selected[0]);
        this._applyScale(true);
    }

    // rates below 1 Mb/s are not real link speeds (PPPoE reports 64 kb/s)
    _linkSpeed(intf) {
        // the WAN's split shares its link
        const speed = this.linkSpeeds[this._isCnx(intf) ? 'wan' : intf] ?? 0;
        return speed >= 1e6 ? speed : 1e9;
    }

    /* The log scale's lines: each power of ten above the floor up to 1 Gb, then
     * each Gb up to the link speed. */
    _steps() {
        let steps = [];
        for (let value = 1e6; value <= Math.min(this.linkSpeed, 1e9); value *= 10) {
            steps.push(value);
        }
        for (let value = 2e9; value <= this.linkSpeed; value += 1e9) {
            steps.push(value);
        }
        return steps;
    }

    /* The auto scale's tops: 1, 1.5, 2, 3, 4, 5 and 7.5 times each power of
     * ten, at most 1.5 times apart so the traffic fills at least three fifths
     * of the height, and each with tenths that make clean lines. The link
     * speed is the last. */
    _autoSteps(linkSpeed) {
        let steps = [];
        for (let power = 1e4; power < linkSpeed; power *= 10) {
            [1, 1.5, 2, 3, 4, 5, 7.5].forEach(m => m * power < linkSpeed && steps.push(m * power));
        }
        steps.push(linkSpeed);
        return steps;
    }

    /* Move the linear axis toward its top as Smoothie Charts does, by a share
     * of the gap each frame: quickly up, so a burst is soon in view, and
     * gently down. The gap is a ratio, so Gb to Mb takes as long as Mb to kb,
     * and the share goes by time, so it moves the same at any frame rate. */
    _glide() {
        const now = performance.now();
        const seconds = this.glideAt === null ? 0 : Math.min((now - this.glideAt) / 1000, 1);
        this.glideAt = now;
        const tau = this.top > this.shownTop ? 0.15 : 0.6;
        this.shownTop = this.top * Math.pow(this.shownTop / this.top, Math.exp(-seconds / tau));
        if (Math.abs(this.top - this.shownTop) < this.top * 1e-3) {
            this.shownTop = this.top;
        }
    }

    _switchScale() {
        this.scale = this.scale === 'log' ? 'auto' : 'log';
        this._graphSave('scale', this.scale);
        this._applyScale(true);
    }

    _yScale() {
        if (this.scale === 'log') {
            return {
                type: 'logarithmic',
                // a little room below the 1 kb/s floor and above the link
                // speed, so a line on either isn't cut in half
                min: 1e3 / 1.3,
                max: this.linkSpeed * 1.3,
                afterBuildTicks: (axis) => {
                    // and a line on the floor, where less (nothing at all too) sits
                    axis.ticks = [1e3, ...this._steps()].map(value => ({value: value}));
                },
                ticks: {
                    // the Gb lines crowd together near the top: name only some
                    callback: (value) => value <= 1e9 || [2e9, 5e9, 1e10].includes(value) ?
                        this._formatBits(value, 0) : ''
                }
            };
        }
        return {
            type: 'linear',
            // the axis ends where it is set below, not at Chart.js's own round numbers
            bounds: 'data',
            afterDataLimits: (axis) => {
                this._glide();
                // the same small room below 0 and above the top
                axis.min = -this.shownTop * 0.02;
                axis.max = this.shownTop * 1.02;
            },
            afterBuildTicks: (axis) => {
                // ten divisions of a step, the one above while the axis is still coming down
                const steps = this._autoSteps(this.linkSpeed);
                const base = this.top >= this.shownTop ? this.top :
                    steps.find(value => value >= this.shownTop * 0.999) ?? this.top;
                axis.ticks = [...Array(11).keys()].map(i => ({value: base * i / 10}))
                    .filter(tick => tick.value <= axis.max);
            },
            ticks: {
                autoSkip: false,
                // every other line named, so the names don't crowd; exact, without trailing zeros
                callback: (value, index) => index % 2 === 0 ?
                    (this._formatBits(value, 2) || '0').replace(/\.?0+ /, ' ') : ''
            }
        };
    }

    /* Every interface's own auto scale, worked out each second whether shown
     * or not, so one is at its scale the moment it is selected: the step that
     * holds all of its traffic in view with a tenth to spare. It goes up as
     * soon as the traffic needs it, and down only once the traffic would leave
     * two fifths spare, so it doesn't flap between two steps. */
    _trackScales(rates) {
        const now = Date.now();
        // everything on screen: the window runs its delay behind, and the
        // curve at its edge reaches a little further
        const shown = this.graph.options.scales.x.realtime;
        const since = now - shown.duration - shown.delay - 1000;
        let peaks = {};
        this.graph.data.datasets.forEach((dataset) => {
            dataset.data.forEach((point) => {
                if (point.x >= since && Number.isFinite(point.rate)) {
                    peaks[dataset.intf] = Math.max(peaks[dataset.intf] ?? 0, point.rate);
                }
            });
        });
        Object.keys(rates).forEach((intf) => {
            const track = this.tracks[intf] ??= {top: null};
            const peak = peaks[intf] ?? 0;
            const steps = this._autoSteps(this._linkSpeed(intf));
            // the smallest step holding the peak with that much spare
            const fit = (spare) => steps.find(value => value >= peak * spare) ?? steps[steps.length - 1];
            if (track.top === null || !steps.includes(track.top) || peak * 1.1 > track.top) {
                track.top = fit(1.1);
            } else if (fit(1.4) < track.top) {
                track.top = fit(1.4);
            }
        });
    }

    /* Show the selected interface's scale; with refit also when it hasn't
     * changed (another interface or scale). */
    _applyScale(refit = false) {
        if (this.scale === 'auto') {
            const top = this.tracks[this.selected[0]]?.top ?? this.top;
            if (top === this.top && !refit) {
                return;
            }
            this.top = top;
            if (!refit) {
                return;     // the axis glides there
            }
            // another interface or scale starts where it belongs
            this.shownTop = top;
        } else if (!refit) {
            return;
        }
        // the log scale floors light traffic, the linear one shows it as it is
        this.graph.data.datasets.forEach((dataset) => {
            dataset.fill = this.scale === 'log' ? 'start' : 'origin';
            dataset.data.forEach((point) => {
                point.y = this.scale === 'log' ? Math.max(point.rate, 1e3) : point.rate;
            });
        });
        this.graph.options.scales.y = this._yScale();
        this.graph.update('none');
    }

    /* The names of the interfaces chosen under the cog across the top, in
     * the order the user dragged them into; select one to show it on its
     * own. As many as fit at full length make a page, and arrows either
     * side of them turn the pages, the right one beside the cog. */
    _graphButtons(data, page = null) {
        this.rowData = data;
        const known = Object.keys(data.interfaces);
        // the saved order, then interfaces added since, the WAN's split at the front
        const added = known.filter(intf => !this.order.includes(intf));
        this.order = added.filter(intf => this._isCnx(intf)).concat(this.order.filter(intf => known.includes(intf)),
            added.filter(intf => !this._isCnx(intf)));
        const shown = this.order.filter(intf => !this.hidden.includes(intf));
        if (shown.length > 0 && !shown.includes(this.selected[0])) {
            this._select(shown[0]);
        }
        const row = $('.traffic-graph-legend');
        const name = intf =>
            `<span class="traffic-graph-intf" data-intf="${intf}" draggable="true" style="flex: 0 1 auto; min-width: 0;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
                margin: 0 2px; padding: 0 5px; border-radius: 3px; border: 1px solid #999999;">` +
            `${data.interfaces[intf].name}</span>`;
        // each name at its full width, then as many to a page as the row holds;
        // one too long for the row on its own gets a page and shortens to fit
        const arrow = (dir, on) =>
            `<i class="fa fa-chevron-${dir} traffic-graph-page" data-step="${dir === 'left' ? -1 : 1}"
                style="flex: 0 0 auto; align-self: center; margin: 0 6px; color: #999999; opacity: ${on ? 1 : 0.3};
                cursor: ${on ? 'pointer' : 'default'};"></i>`;
        const cog = `<i class="fa fa-cog traffic-graph-settings" title="${this.translations.chooseinterfaces}"
            style="flex: 0 0 auto; align-self: center; margin-left: 6px; cursor: pointer; color: #999999;"></i>`;
        this.pages = [shown];
        // the names take at most 0.628 of the graph's width, centred over it
        const area = this.graph?.chartArea;
        this.listFor = area ? Math.round(area.right - area.left) : null;
        const limit = area ? Math.min(row.width(), (area.right - area.left) * 0.628) : row.width();
        if (limit > 0 && shown.length > 0) {
            row.html(shown.map(name).join('') + arrow('left', true) + arrow('right', true) + cog);
            const widths = row.children().toArray().map(elem => $(elem).css('flex-shrink', 0).outerWidth(true));
            // the cog always, and both arrows should it come to pages
            const all = widths.slice(0, shown.length).reduce((sum, width) => sum + width, 0);
            const room = limit - widths[shown.length + 2] - (all > limit - widths[shown.length + 2] ?
                widths[shown.length] + widths[shown.length + 1] : 0);
            this.pages = [];
            let current = [], used = 0;
            shown.forEach((intf, i) => {
                if (current.length > 0 && used + widths[i] > room) {
                    this.pages.push(current);
                    current = [];
                    used = 0;
                }
                current.push(intf);
                used += widths[i];
            });
            this.pages.push(current);
        }
        // the page asked for, else the one with the interface on screen
        this.page = page ?? Math.max(0, this.pages.findIndex(names => names.includes(this.selected[0])));
        this.page = Math.min(Math.max(this.page, 0), this.pages.length - 1);
        const paged = this.pages.length > 1;
        row.html((paged ? arrow('left', this.page > 0) : '') + this.pages[this.page].map(name).join('') +
            (paged ? arrow('right', this.page < this.pages.length - 1) : '') + cog +
            '<span class="traffic-graph-marker" style="position: absolute; top: 0; bottom: 0; width: 2px; ' +
            'background: #D94F00; display: none; pointer-events: none;"></span>');
        $('.traffic-graph-settings').on('click', (event) => {
            event.stopPropagation();
            this._chooseInterfaces(data);
        });
        $('.traffic-graph-intf').on('click', (event) => {
            this._select($(event.currentTarget).data('intf'));
        }).on('dragstart', (event) => {
            this.dragged = $(event.currentTarget).data('intf');
            event.originalEvent.dataTransfer.effectAllowed = 'move';
            event.originalEvent.dataTransfer.setData('text/plain', this.dragged);
        }).on('dragend', () => {
            this.dragged = undefined;
            $('.traffic-graph-marker').hide();
        });
        const onPage = this.pages[this.page];
        const move = (intf, before) => {
            const others = this.order.filter(other => other !== intf);
            others.splice(before === null ? others.indexOf(onPage.filter(other => other !== intf).slice(-1)[0]) + 1 :
                others.indexOf(before), 0, intf);
            this.order = others;
            this._graphSave('order', this.order);
            this._graphButtons(data, Math.max(0, this.pages.findIndex(names => names.includes(intf))));
            if ($('.traffic-graph-choose').is(':visible')) {
                this._fillChooser(data);
            }
        };
        // an arrow turns the page, or takes a name dropped on it to that end of
        // this page, from where it moves on to the next as the pages refill
        $('.traffic-graph-page').on('click', (event) => {
            const to = this.page + $(event.currentTarget).data('step');
            if (to >= 0 && to < this.pages.length) {
                this._graphButtons(data, to);
            }
        }).on('dragover', (event) => {
            event.preventDefault();
            event.stopPropagation();
            $('.traffic-graph-marker').hide();
        }).on('drop', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const intf = this.dragged;
            this.dragged = undefined;
            const first = onPage.find(other => other !== intf);
            if (intf !== undefined && first !== undefined) {
                move(intf, $(event.currentTarget).data('step') < 0 ? first : null);
            }
        });
        // the whole row takes the drop, gaps between names included, with a
        // marker where it will land
        const marker = $('.traffic-graph-marker');
        row.off('.trafficorder').on('dragover.trafficorder', (event) => {
            event.preventDefault();
            event.originalEvent.dataTransfer.dropEffect = 'move';
            if (this.dragged !== undefined) {
                const drop = this._dropAt(event.originalEvent.clientX);
                const box = event.currentTarget.getBoundingClientRect();
                marker.css({'left': `${drop.x - box.left - 1}px`, 'display': 'block'});
            }
        }).on('dragleave.trafficorder', (event) => {
            if (!event.currentTarget.contains(event.originalEvent.relatedTarget)) {
                marker.hide();
            }
        }).on('drop.trafficorder', (event) => {
            event.preventDefault();
            marker.hide();
            const intf = this.dragged;
            this.dragged = undefined;
            if (intf === undefined) {
                return;
            }
            // beside the name on this page it was dropped by; others keep their place
            const neighbours = onPage.filter(other => other !== intf);
            const at = this._dropAt(event.originalEvent.clientX).at;
            if (neighbours.length > 0) {
                move(intf, at < neighbours.length ? neighbours[at] : null);
            }
        });
        this._graphButtonStates();
    }

    _select(intf) {
        this.selected = [intf];
        this._graphSave('graph', this.selected);
        this.graph.data.datasets.forEach(dataset => { dataset.hidden = !this.selected.includes(dataset.intf); });
        this._graphScale();
        this._graphButtonStates();
        this._headerRates();
        this.graph.update('quiet');
    }

    /* Open or close the list of interfaces to show in the row, under the cog.
     * Each tick applies at once; the last one shown can't be taken away. */
    _chooseInterfaces(data) {
        const list = $('.traffic-graph-choose');
        if (list.is(':visible')) {
            list.hide();
            return;
        }
        this._fillChooser(data);
        // on the widget's own background, under the cog, within the graph
        let back = null;
        for (let el = list[0]; el && (!back || /rgba\(.*,\s*0\)$|transparent/.test(back)); el = el.parentElement) {
            back = getComputedStyle(el).backgroundColor;
        }
        const view = list.parent()[0].getBoundingClientRect();
        const cog = $('.traffic-graph-settings')[0].getBoundingClientRect();
        const top = cog.bottom - view.top + 4;
        list.css({
            'top': `${top}px`,
            'right': `${Math.max(4, view.right - cog.right - 4)}px`,
            'max-height': `${view.height - top - 8}px`,
            'background': back,
            'display': 'block'
        });
        // a click anywhere else closes it
        $(document).off(`click.trafficchoose${this.id}`).on(`click.trafficchoose${this.id}`, (event) => {
            if (!list[0].contains(event.target)) {
                list.hide();
                $(document).off(`click.trafficchoose${this.id}`);
            }
        });
    }

    /* The ticks, in the row's order, the ones left out where they were. */
    _fillChooser(data) {
        const list = $('.traffic-graph-choose');
        list.html(this.order.map(intf =>
            '<label style="display: flex; align-items: center; gap: 6px; margin: 0; font-weight: normal; white-space: nowrap; cursor: pointer;">' +
            `<input type="checkbox" data-intf="${intf}" style="margin: 0;"${this.hidden.includes(intf) ? '' : ' checked'}>` +
            `${data.interfaces[intf].name}</label>`).join(''));
        list.find('input').on('change', (event) => {
            const intf = $(event.currentTarget).data('intf');
            if (event.currentTarget.checked) {
                this.hidden = this.hidden.filter(other => other !== intf);
            } else if (this.order.filter(other => !this.hidden.includes(other)).length > 1) {
                this.hidden.push(intf);
            } else {
                event.currentTarget.checked = true;
                return;
            }
            this._graphSave('hidden', this.hidden);
            this._graphButtons(data);
        });
    }

    _dropAt(x) {
        const others = $('.traffic-graph-intf').toArray().filter(elem => $(elem).data('intf') !== this.dragged);
        for (let i = 0; i < others.length; i++) {
            const box = others[i].getBoundingClientRect();
            if (x < box.left + box.width / 2) {
                const prev = i > 0 ? others[i - 1].getBoundingClientRect() : null;
                return {at: i, x: prev ? (prev.right + box.left) / 2 : box.left - 2};
            }
        }
        const last = others.length > 0 ? others[others.length - 1].getBoundingClientRect() : null;
        return {at: others.length, x: last ? last.right + 2 : x};
    }

    _graphSave(key, value) {
        try {
            window.localStorage.setItem(`opnsense.widget.traffic.${key}`, JSON.stringify(value));
        } catch (e) { /* not remembered then */ }
    }

    /* Grey outlines, the selected name in the dashboard's accent colour. */
    _graphButtonStates() {
        $('.traffic-graph-intf').each((i, elem) => {
            const on = this.selected.includes($(elem).data('intf'));
            $(elem).css({
                'background': on ? '#D94F00' : 'transparent',
                'border-color': on ? '#D94F00' : '#999999',
                'color': on ? '#fff' : ''
            });
        });
    }

    /* The full name and current rates of each interface, on hovering its name. */
    _graphRates(data, rates) {
        $('.traffic-graph-intf').each((i, elem) => {
            const intf = $(elem).data('intf');
            if (rates[intf] !== undefined) {
                const [down, up] = [rates[intf].inbytes, rates[intf].outbytes].map(rate => this._rateParts(rate).join(' '));
                $(elem).attr('title', `${data.interfaces[intf].name}: \u2193 ${down} \u2191 ${up}`);
            }
        });
    }

    // the measured rate at a time, straight between the samples either side
    _rateAt(points, time) {
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            if (a.x <= time && time <= b.x && Number.isFinite(a.rate) && Number.isFinite(b.rate)) {
                return a.rate + (b.rate - a.rate) * (b.x === a.x ? 0 : (time - a.x) / (b.x - a.x));
            }
        }
        return null;
    }

    /* Where a drawn line is at x: on the curve between the samples either
     * side, as Chart.js drew it from their control points, else straight. */
    _curveAt(points, x) {
        const bezier = (p0, p1, p2, p3, t) =>
            (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            if (a.x > x || x > b.x || a.skip || b.skip) {
                continue;
            }
            if (a.cp2x === undefined || b.cp1x === undefined) {
                return a.y + (b.y - a.y) * (b.x === a.x ? 0 : (x - a.x) / (b.x - a.x));
            }
            // the curve runs left to right, so halve towards x
            let low = 0, high = 1, t = 0.5;
            for (let step = 0; step < 20; step++) {
                t = (low + high) / 2;
                if (bezier(a.x, a.cp2x, b.cp1x, b.x, t) < x) {
                    low = t;
                } else {
                    high = t;
                }
            }
            return bezier(a.y, a.cp2y, b.cp1y, b.y, t);
        }
        return null;
    }

    // number and unit apart, each to its own place in the header; from Kb up,
    // as bits a second are no more telling than a fraction of a Kb
    _rateParts(rate) {
        return rate >= 1000 ? this._formatBits(rate, 1).split(' ') : [(rate / 1000).toFixed(1), 'Kb'];
    }

    /* The reference line's way up from the graph to the header: a dot
     * between the rates and a line down to the graph, broken where it
     * crosses the interface names. Moved only when something moved. */
    _referenceAbove(at) {
        const parts = $('.traffic-reference');
        if (parts.length === 0) {
            return;
        }
        const wrap = parts.parent()[0].getBoundingClientRect();
        const key = at === null ? 'none' : [at.x - wrap.left, at.top.top, at.top.bottom, at.row.top, at.row.bottom,
            at.bottom, wrap.top].map(Math.round).join() + at.color;
        if (key === this.referenceKey) {
            return;
        }
        this.referenceKey = key;
        if (at === null) {
            parts.hide();
            return;
        }
        const x = at.x - wrap.left;
        const dot = (at.top.top + at.top.bottom) / 2 - wrap.top;
        const gapTop = at.row.top - 3 - wrap.top, gapBottom = at.row.bottom + 3 - wrap.top;
        const end = at.bottom - wrap.top;
        $('.traffic-reference-dot').css({'left': `${x - 2}px`, 'top': `${dot - 2.5}px`, 'background': '#999999', 'display': 'block'});
        $('.traffic-reference-upper').css({'left': `${x}px`, 'top': `${dot}px`, 'height': `${Math.max(0, gapTop - dot)}px`,
            'background': at.color, 'display': 'block'});
        $('.traffic-reference-lower').css({'left': `${x}px`, 'top': `${gapBottom}px`, 'height': `${Math.max(0, end - gapBottom)}px`,
            'background': at.color, 'display': 'block'});
    }

    // the header's numbers, written only when they change
    _headerValues(parts) {
        const key = JSON.stringify(parts);
        if (key === this.headerKey) {
            return;
        }
        this.headerKey = key;
        this.headerParts = parts;
        const rates = $('.traffic-header-rates');
        ['in', 'out'].forEach((dir, i) => {
            rates.find(`.traffic-header-${dir} .traffic-header-number`).text(parts[i][0]);
            rates.find(`.traffic-header-${dir} .traffic-header-unit`).text(parts[i][1]);
        });
    }

    /* The shown interface's rates in the header, centred left of the title,
     * in and out apart in the key's colours, as the graph has them at the
     * line below the gap between them. Arrows and units keep their place and
     * the numbers stand right aligned between them, so only the digits
     * change. */
    _headerRates() {
        const slot = $(`#${this.id}-title`).siblings('.widget-header-left');
        let rates = slot.children('.traffic-header-rates');
        if (rates.length === 0) {
            slot.css({'justify-content': 'flex-start', 'min-width': '0'});
            const part = (dir, arrow, color, gap) =>
                `<span class="traffic-header-${dir}" style="display: inline-flex; align-items: baseline; color: ${color}; margin-left: ${gap}px;">` +
                `<span style="font-size: 1.2em;">${arrow}</span>` +
                '<span class="traffic-header-number" style="display: inline-block; text-align: right;"></span>' +
                '<span class="traffic-header-unit" style="display: inline-block; margin-left: 0.25em;"></span></span>';
            rates = $('<span class="traffic-header-rates" style="flex: 0 0 auto; white-space: nowrap; overflow: hidden; ' +
                'font-weight: bold; letter-spacing: -0.03em;">' +
                part('in', '\u2193', '#5E9C4A', 0) + part('out', '\u2191', '#F28E2B', 32) + '</span>');
            slot.append(rates);
        }
        // a size up from the interface names, in their type
        const name = $('.traffic-graph-intf').first();
        if (name.length > 0 && name.is(':visible') && name.css('font-size') !== this.rateFont) {
            this.rateFont = name.css('font-size');
            rates.css({'font-size': `${parseFloat(this.rateFont) * 1.25}px`, 'font-family': name.css('font-family')});
            // room for the widest number and unit
            const widest = (elem, texts) => Math.ceil(Math.max(...texts.map(text =>
                $(elem).css('width', 'auto').text(text)[0].getBoundingClientRect().width))) + 1;
            const numbers = rates.find('.traffic-header-number');
            const units = rates.find('.traffic-header-unit');
            numbers.css('width', `${widest(numbers[0], ['888.8'])}px`);
            units.css('width', `${widest(units[0], ['Kb', 'Mb', 'Gb'])}px`);
        }
        // only for the one graph: the separate graphs show their own
        rates.css('display', this.view === 'graph' ? '' : 'none');
        // the numbers themselves come from the graph, at its reference line
        this.headerKey = null;
        this._headerValues(this.headerParts ?? [['', ''], ['', '']]);
    }

    /* The rates with their gap over the graph's line, but clear of the In
     * key, and the title moved right only as far as they need, up to the
     * icons. Done only when something moved, not on every frame. */
    _placeHeader(lineX) {
        const rates = $('.traffic-header-rates');
        const title = $(`#${this.id}-title`);
        const down = rates.find('.traffic-header-in'), up = rates.find('.traffic-header-out');
        if (rates.length === 0 || title.length === 0 || !rates.is(':visible')) {
            return;
        }
        const slot = rates.parent()[0].getBoundingClientRect();
        const key = $('.traffic-graph-key-in');
        const keyRight = key.is(':visible') ? key[0].getBoundingClientRect().right : slot.left;
        const commands = title.siblings('.widget-command-container').children(':visible').first();
        const place = [lineX, slot.left, slot.right, keyRight, rates[0].offsetWidth, title[0].offsetWidth,
            commands.length ? commands[0].getBoundingClientRect().left : 0].map(Math.round).join();
        if (place === this.headerPlace) {
            return;
        }
        this.headerPlace = place;
        // the gap's middle as it is with the usual 32 px between In and Out
        const inEnd = down[0].getBoundingClientRect().right - rates[0].getBoundingClientRect().left;
        const gap = inEnd + 16;
        const left = Math.max(lineX - gap, keyRight + 8);
        rates.css('margin-left', `${Math.max(0, left - slot.left)}px`);
        // pushed right by the key: Out as far right of the line as In ends left of it
        up.css('margin-left', left > lineX - gap ? `${Math.max(12, Math.round(2 * (lineX - (left + inEnd))))}px` : '32px');
        const box = rates[0].getBoundingClientRect();
        // where the title sits unmoved, then just past the rates if they reach it
        title.css({'position': 'relative', 'left': '0px'});
        const natural = title[0].getBoundingClientRect();
        let shift = Math.max(0, left + box.width + 16 - natural.left);
        if (commands.length) {
            shift = Math.min(shift, Math.max(0, commands[0].getBoundingClientRect().left - 8 - natural.right));
        }
        title.css('left', `${shift}px`);
    }

    _setView(view) {
        this.view = view;
        try {
            window.localStorage.setItem('opnsense.widget.traffic.view', view);
        } catch (e) { /* not remembered then */ }
        // the separate graphs stay in place underneath to keep the widget's size
        $('.traffic-charts-container').css('visibility', view === 'graph' ? 'hidden' : 'visible');
        // flex, not the block that .toggle() would give it: the graph takes what the names leave
        $('.traffic-graph-view').css('display', view === 'graph' ? 'flex' : 'none');
        // the names can only be measured into pages where they show
        if (view === 'graph' && this.rowData) {
            this._graphButtons(this.rowData);
        }
        // the graph stops drawing when not shown, so put its line away here
        if (view !== 'graph') {
            this._referenceAbove(null);
            $(`#${this.id}-title`).css('left', '0px');
            this.headerPlace = null;
        }
        $('.traffic-graph-key').css('display', view === 'graph' ? 'inline-block' : 'none');
        // only the shown view needs drawing
        for (let chart of Object.values(this.charts)) {
            if (chart !== null) {
                chart.options.scales.x.realtime.pause = view === 'graph';
            }
        }
        if (this.graph !== null) {
            this.graph.options.scales.x.realtime.pause = view !== 'graph';
        }
        this._headerRates();
    }

    async _initialize(data) {
        const config = await this.getWidgetConfig();
        this._originalDatasets(data, config);

        this.charts.trafficIn = new Chart($('#traffic-in')[0].getContext('2d'), this._chartConfig(this.datasets.inbytes));
        this.charts.trafficOut = new Chart($('#traffic-out')[0].getContext('2d'), this._chartConfig(this.datasets.outbytes));

        await this._linkSpeeds();
        this.graph = new Chart($('#traffic-graph')[0].getContext('2d'), this._graphConfig());
        // Clicking the scale switches between fitting the traffic and the fixed log
        // scale. On the canvas itself: Chart.js only reports events inside the plot.
        const onScale = (event) => event.clientX - this.graph.canvas.getBoundingClientRect().left < this.graph.chartArea.left;
        this.graph.canvas.addEventListener('mousemove', (event) => {
            this.graph.canvas.style.cursor = onScale(event) ? 'pointer' : 'default';
        });
        this.graph.canvas.addEventListener('click', (event) => {
            if (onScale(event)) {
                this._switchScale();
            }
        });
        $('.traffic-scale-switch').on('click', () => this._switchScale());
        this.graph.data.datasets = this._graphDatasets(data);
        this._graphScale();
        this._graphButtons(data);
        this._setView(this.view);
        // the header is surely in place by now, should it not have been at render
        this._placeToggle();
        this.interfaceList = this._interfaceList(data);
    }

    _originalDatasets(data, config) {
        this.datasets = {inbytes: [], outbytes: []};
        for (const dir of ['inbytes', 'outbytes']) {
            let colors = Chart.colorschemes.tableau.Classic10;
            let i = 0;
            // the separate graphs show the interfaces only
            Object.keys(data.interfaces).filter(intf => !this._isCnx(intf)).forEach((intf) => {
                let idx = i % colors.length;
                i++;
                this.datasets[dir].push({
                    label: data.interfaces[intf].name,
                    hidden: !config.interfaces.includes(intf),
                    borderColor: colors[idx],
                    backgroundColor: this._set_alpha(colors[idx], 0.5),
                    pointHoverBackgroundColor: colors[idx],
                    pointHoverBorderColor: colors[idx],
                    pointBackgroundColor: colors[idx],
                    pointBorderColor: colors[idx],
                    pointRadius: 0,
                    intf: intf,
                    last_time: data.time,
                    src_field: dir,
                    data: [],
                });
            });
        }
    }

    async _linkSpeeds() {
        const stats = await this.ajaxCall('/api/diagnostics/traffic/interface');
        Object.keys(stats.interfaces ?? {}).forEach(intf => {
            this.linkSpeeds[intf] = parseInt(stats.interfaces[intf]['line rate'] ?? 0);
        });
    }

    // which interfaces there are and what they are called
    _interfaceList(data) {
        return JSON.stringify(Object.keys(data.interfaces).map(intf => [intf, data.interfaces[intf].name]));
    }

    /* Interfaces were added, removed or renamed since the graphs were set up:
     * set both views up for the ones there are now. */
    async _refreshInterfaces(data) {
        const config = await this.getWidgetConfig();
        this._originalDatasets(data, config);
        this.charts.trafficIn.data.datasets = this.datasets.inbytes;
        this.charts.trafficOut.data.datasets = this.datasets.outbytes;
        await this._linkSpeeds();
        this.graph.data.datasets = this._graphDatasets(data);
        this._graphScale();
        this._graphButtons(data);
        if ($('.traffic-graph-choose').is(':visible')) {
            this._fillChooser(data);
        }
        this.charts.trafficIn.update('none');
        this.charts.trafficOut.update('none');
        this.graph.update('none');
    }

    async _onMessage(event) {
        if (!event) {
            super.closeEventSource();
        }

        const data = this._withOffload(JSON.parse(event.data));

        if (!this.initialized) {
            this.initialized = this._initialize(data);
        }
        await this.initialized;

        if (this.checkInterfaces) {
            this.checkInterfaces = false;
            if (this._interfaceList(data) !== this.interfaceList) {
                this.interfaceList = this._interfaceList(data);
                await this._refreshInterfaces(data);
            }
        }

        let config = null;
        if (this.configChanged) {
            config = await this.getWidgetConfig();
        }

        let rates = {};
        this.graph.data.datasets.forEach((dataset) => {
            const counter = data.interfaces[dataset.intf];
            if (counter === undefined) {
                return;
            }
            // the message the graph was set up from has no time before it to make a rate of
            if (!(data.time > dataset.last_time)) {
                return;
            }
            const rate = Math.round((counter[dataset.src_field] / (data.time - dataset.last_time)) * 8);
            // the log scale starts at 1 kb/s: less sits on its floor
            dataset.data.push({x: Date.now(), y: this.scale === 'log' ? Math.max(rate, 1e3) : rate, rate: rate});
            dataset.last_time = data.time;
            rates[dataset.intf] ??= {};
            rates[dataset.intf][dataset.src_field] = rate;
        });
        this._graphRates(data, rates);
        this._trackScales(rates);
        this._applyScale();
        this.graph.update('quiet');

        for (let chart of Object.values(this.charts)) {
            Object.keys(data.interfaces).forEach((intf) => {
                chart.config.data.datasets.forEach((dataset) => {
                    if (dataset.intf === intf) {
                        let elapsed_time = data.time - dataset.last_time;
                        if (this.configChanged) {
                            // check hidden status of dataset
                            dataset.hidden = !config.interfaces.includes(intf);
                        }
                        dataset.data.push({
                            x: Date.now(),
                            y: Math.round(((data.interfaces[intf][dataset.src_field]) / elapsed_time) * 8, 0)
                        });
                        dataset.last_time = data.time;
                        return;
                    }
                });
            });
            chart.update('quiet');
        }

        if (this.configChanged) {
            this.configChanged = false;
        }
    }

    getMarkup() {
        return $(`
            <div style="position: relative;">
                <i class="fa fa-exchange fa-xs traffic-view-toggle" title="${this.translations.switchview}"
                   style="position: absolute; top: 0; right: 0; z-index: 1; cursor: pointer;"></i>
                <i class="fa fa-camera fa-xs traffic-image-button" title="${this.translations.image}"
                   style="position: absolute; top: 0; right: 0; z-index: 1; cursor: pointer;"></i>
                <div class="traffic-reference traffic-reference-dot" style="position: absolute; display: none; pointer-events: none;
                     width: 5px; height: 5px; border-radius: 50%;"></div>
                <div class="traffic-reference traffic-reference-upper" style="position: absolute; display: none; pointer-events: none; width: 1px;"></div>
                <div class="traffic-reference traffic-reference-lower" style="position: absolute; display: none; pointer-events: none; width: 1px;"></div>
                <span class="traffic-graph-key traffic-graph-key-in" style="position: absolute; top: 0; left: 0; z-index: 1;
                      display: none; white-space: nowrap;">
                    <span class="traffic-graph-dot" style="display: inline-block; border-radius: 50%; background: #5E9C4A;"></span>
                    ${this.translations.in}
                </span>
                <span class="traffic-graph-key traffic-graph-key-out" style="position: absolute; top: 0; left: 0; z-index: 1;
                      display: none; white-space: nowrap;">
                    <span class="traffic-graph-dot" style="display: inline-block; border-radius: 50%; background: #F28E2B;"></span>
                    ${this.translations.out}
                </span>
                <div class="traffic-charts-container">
                    <h3>${this.translations.trafficin}</h3>
                    <div class="canvas-container-noaspectratio">
                        <canvas id="traffic-in"></canvas>
                    </div>
                    <h3>${this.translations.trafficout}</h3>
                    <div class="canvas-container-noaspectratio">
                        <canvas id="traffic-out"></canvas>
                    </div>
                </div>
                <div class="traffic-graph-view" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                     display: none; flex-direction: column; padding-bottom: 8px;">
                    <div class="traffic-graph-legend" style="position: relative; display: flex; justify-content: center; font-size: 11px; line-height: 16px; padding: 0 22px; margin-bottom: 4px;"></div>
                    <div class="traffic-graph-choose widget-image-skip" style="position: absolute; z-index: 3; display: none; overflow-y: auto;
                         font-size: 11px; line-height: 20px; padding: 4px 8px; border: 1px solid #999999; border-radius: 3px;"></div>
                    <div style="position: relative; flex: 1 1 0; min-height: 0; overflow: hidden;">
                        <!-- out of the flow, so the canvas can't make the space it is sized from grow -->
                        <canvas id="traffic-graph" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></canvas>
                        <span class="traffic-scale-switch" title="${this.translations.switchscale}"
                              style="position: absolute; z-index: 1; cursor: pointer; font-size: 10px; line-height: 13px;
                              padding: 0 3px; border: 1px solid #999999; border-radius: 3px;"></span>
                    </div>
                </div>
            </div>
        `);
    }

    /* Put the toggle right under the header's link icon, in its colour, and
     * the picture button under that. */
    _placeToggle() {
        const link = $(`#link-handle-${this.id} i`);
        const toggle = $('.traffic-view-toggle');
        if (link.length === 0 || toggle.length === 0) {
            return;
        }
        const linkBox = link[0].getBoundingClientRect();
        // below the whole link, which is taller than its icon's box
        const handleBox = $(`#link-handle-${this.id}`)[0].getBoundingClientRect();
        const parentBox = toggle.parent()[0].getBoundingClientRect();
        const centre = linkBox.left + linkBox.width / 2;
        toggle.css({
            'top': `${Math.max(handleBox.bottom, linkBox.bottom) - parentBox.top + 8}px`,
            'right': `${parentBox.right - centre - toggle.outerWidth() / 2}px`,
            'color': link.css('color')
        });
        // The colour key mirrors them in the top left corner, sized like the
        // icons: In level with the link, Out with the toggle. By font size, as
        // an icon's box is next to no height and its glyph drawn around it.
        const size = parseFloat(link.css('font-size')) * 1.25;
        const toggleBox = toggle[0].getBoundingClientRect();
        $('.traffic-graph-key').css({
            'left': `${parentBox.right - centre - toggle.outerWidth() / 2}px`,
            'font-size': `${size}px`,
            'line-height': `${size}px`
        });
        $('.traffic-graph-dot').css({'width': `${size * 0.75}px`, 'height': `${size * 0.75}px`});
        $('.traffic-graph-key-in').css('top', `${linkBox.top + linkBox.height / 2 - parentBox.top - size / 2}px`);
        $('.traffic-graph-key-out').css('top', `${toggleBox.top + toggleBox.height / 2 - parentBox.top - size / 2}px`);
        // the picture button one step further down, as far from the toggle as that is from the link
        const step = (toggleBox.top + toggleBox.height / 2) - (linkBox.top + linkBox.height / 2);
        $('.traffic-image-button').css({
            'top': `${toggleBox.top - parentBox.top + step}px`,
            'right': toggle.css('right'),
            'color': link.css('color')
        });
    }

    async onMarkupRendered() {
        $('.traffic-view-toggle').on('click', () => {
            this._setView(this.view === 'graph' ? 'original' : 'graph');
        });
        $('.traffic-image-button').on('click', (event) => this._saveImage(event.currentTarget));
        this._placeToggle();
        // back to the window: see whether the interfaces changed meanwhile
        $(window).on(`focus.trafficinterfaces${this.id}`, () => { this.checkInterfaces = true; });
        super.openEventSource(`/api/diagnostics/traffic/stream/${'1'}`, this._onMessage.bind(this));
    }

    // never narrower than a quarter of the full grid
    getGridOptions() {
        return {minW: 3};
    }

    onWidgetResize(elem, width, height) {
        this._placeToggle();
        // as many names to a page as the new width holds
        if (this.rowData) {
            this._graphButtons(this.rowData);
        }
        return false;
    }

    onVisibilityChanged(visible) {
        // Nothing was sampled while hidden. Start the graph's lines again
        // instead of drawing them across the gap to the first new sample.
        if (visible && this.graph !== null) {
            this.graph.data.datasets.forEach(dataset => { dataset.data = []; });
        }
        // and see whether the interfaces changed meanwhile
        if (visible) {
            this.checkInterfaces = true;
        }
        super.onVisibilityChanged(visible);
    }

    async getWidgetOptions() {
        const data = await this.ajaxCall('/api/diagnostics/traffic/interface');

        const interfaces = Object.entries(data.interfaces).map(([key, intf]) => {
            return [key, intf.name]
        });

        return {
            interfaces: {
                title: this.translations.interfaces,
                type: 'select_multiple',
                options: interfaces.map(([key,intf]) => {
                    return {
                        value: key,
                        label: intf,
                    };
                }),
                default: interfaces
                    .filter(([key]) => key === 'lan' || key === 'wan')
                    .map(([key]) => (key))
            }
        };
    }

    async onWidgetOptionsChanged(options) {
        this.configChanged = true;
    }

    onWidgetClose() {
        super.onWidgetClose();
        $(document).off(`click.trafficchoose${this.id}`);
        $(window).off(`focus.trafficinterfaces${this.id}`);
        if (this.charts.trafficIn !== null) {
            this.charts.trafficIn.destroy();
        }
        if (this.charts.trafficOut !== null) {
            this.charts.trafficOut.destroy();
        }
        if (this.graph !== null) {
            this.graph.destroy();
        }
    }
}
