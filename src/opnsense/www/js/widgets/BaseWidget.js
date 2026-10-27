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

class BaseWidget {
    constructor(config) {
        this.config = config;
        this.id = null;
        this.translations = {};
        this.tickTimeout = 10; // Default tick timeout
        this.resizeHandles = "all"
        this.eventSource = null;
        this.eventSourceUrl = null;
        this.eventSourceOnData = null;
        this.cachedData = {};
        this.titleVisible = true;

        /* Connection timeout params */
        this.timeoutPeriod = 5000;
        this.retryLimit = 3;
        this.eventSourceRetryCount = 0; // retrycount for $.ajax is managed in its own scope

        this.configurable = false;
    }

    /* Public functions */

    getResizeHandles() {
        return this.resizeHandles;
    }

    setWidgetConfig(config) {
        this.config['widget'] = config;
    }

    async getWidgetConfig() {
        let widget_config = {};
        if (this.config !== undefined && 'widget' in this.config) {
            widget_config = this.config['widget'];
        }
        const options = await this.getWidgetOptions();
        return Object.entries(options).reduce((acc, [key, value]) => {
            if (key in widget_config &&
                widget_config[key] !== null &&
                widget_config[key] !== undefined &&
                !(Array.isArray(widget_config[key]) && widget_config[key].length === 0) &&
                !(typeof widget_config[key] === 'object' && !Array.isArray(widget_config[key]) && Object.keys(widget_config[key]).length === 0) &&
                !(typeof widget_config[key] === 'string' && widget_config[key].length === 0)
            ) {
                if (value.type === 'select_multiple') {
                    const optionsArr = value.options.map(v => v.value);
                    if (!(widget_config[key].some(v => optionsArr.includes(v)))) {
                        // if there is config data, but none of the
                        // options match, set it to the default.
                        acc[key] = value.default;
                        return acc;
                    }
                }

                acc[key] = widget_config[key];
            } else {
                acc[key] = value.default;
            }
            return acc;
        }, {});
    }

    setId(id) {
        this.id = id;
    }

    setTranslations(translations) {
        this.translations = translations;
    }

    isConfigurable() {
        return this.configurable;
    }

    /* Public virtual/override functions */

    getGridOptions() {
        // per-widget gridstack options override
        return {};
    }

    get dialogTitle() {
        return null;
    }

    getMarkup() {
        return $("");
    }

    async onMarkupRendered() {
        return null;
    }

    onWidgetResize(elem, width, height) {
        return false;
    }

    async onWidgetTick() {
        return null;
    }

    onWidgetClose() {
        this.closeEventSource();
    }

    onVisibilityChanged(visible) {
        if (this.eventSourceUrl !== null) {
            if (visible) {
                this.openEventSource(this.eventSourceUrl, this.eventSourceOnData);
            } else if (this.eventSource !== null) {
                this.closeEventSource();
            }
        }
    }

    async getWidgetOptions() {
        return {};
    }

    onWidgetOptionsChanged(options) {
        return null;
    }

    isTitleVisible() {
        return this.titleVisible;
    }

    /* Utility/protected functions */

    ajaxCall(url, data={}, method='GET') {
        let retryLimit = this.retryLimit;
        let timeoutPeriod = this.timeoutPeriod;
        return new Promise((resolve, reject) => {
            function makeRequest() {
                $.ajax({
                    type: method,
                    url: url,
                    dataType: 'json',
                    contentType: 'application/json',
                    data: data,
                    tryCount: 0,
                    retryLimit: retryLimit,
                    timeout: timeoutPeriod,
                    success: function (responseData) {
                        resolve(responseData);
                    },
                    error: function (xhr, textStatus, errorThrown) {
                        if (textStatus === 'timeout') {
                            this.tryCount++;
                            if (this.tryCount <= this.retryLimit) {
                                $.ajax(this);
                                return;
                            }
                        }
                        reject({ xhr, textStatus, errorThrown });
                    }
                });
            }

            makeRequest();
        });
    }

    dataChanged(id, data) {
        if (id in this.cachedData) {
            if (JSON.stringify(this.cachedData[id]) !== JSON.stringify(data)) {
                this.cachedData[id] = data;
                return true;
            }
        } else {
            this.cachedData[id] = data;
            return true;
        }

        return false;
    }

    openEventSource(url, onMessage) {
        this.closeEventSource();

        if (this.eventSourceRetryCount >= this.retryLimit) {
            return;
        }

        this.eventSourceUrl = url;
        this.eventSourceOnData = onMessage;
        this.eventSource = new EventSource(url);

        /* Unlike $.ajax, EventSource does not have a timeout mechanism */
        let timeoutHandler = setTimeout(() => {
            this.closeEventSource();
            this.eventSourceRetryCount++;
            this.openEventSource(url, onMessage);
        }, this.timeoutPeriod);

        this.eventSource.onopen = (event) => {
            clearTimeout(timeoutHandler);
            this.eventSourceRetryCount = 0;
        };

        this.eventSource.onmessage = onMessage;
        this.eventSource.onerror = (e) => {
            if (this.eventSource.readyState == EventSource.CONNECTING) {
                /* Backend closed connection due to timeout, reconnect issued by browser */
                return;
            }

            if (this.eventSource.readyState == EventSource.CLOSED) {
                this.closeEventSource();
            } else {
                console.error('Unknown error occurred during streaming operation', e);
            }
        };
    }

    closeEventSource() {
        if (this.eventSource !== null) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }

    /* For testing purposes */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _setAlpha(color, opacity) {
        const op = Math.round(Math.min(Math.max(opacity || 1, 0), 1) * 255);
        return color + op.toString(16).toUpperCase();
    }

    _formatBits(value, decimals = 2) {
        return this._formatField(value, decimals, true);
    }

    _formatBytes(value, decimals = 2) {
        return this._formatField(value, decimals);
    }

    _formatField(value, decimals = 2, bits = false) {
        value = Number(value);
        if (isNaN(value) || value === null || value <= 0) {
            return "";
        }

        let fileSizeTypes = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
        const ndx = Math.floor(Math.log(value) / Math.log(1000));

        const suffix = bits ? 'b' : 'B';
        if (ndx > 0) {
            return `${(value / Math.pow(1000, ndx)).toFixed(decimals)} ${fileSizeTypes[ndx]}${suffix}`;
        }

        return `${value.toFixed(decimals)} ${fileSizeTypes[0]}${suffix}`;
    }

    /* A picture of the widget as shown, copied for pasting and saved as a
     * PNG. Drawn from the page itself, so it needs nothing from outside:
     * every shown element's background, borders, canvas and text where the
     * browser placed them, without the buttons in the corner. */
    async _saveImage(button) {
        const panel = $(`.widget-${this.id}`)[0];
        const box = panel.getBoundingClientRect();
        const scale = Math.max(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(box.width * scale);
        canvas.height = Math.round(box.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);

        const clear = (color) => !color || color === 'transparent' || /rgba\(.*,\s*0\)$/.test(color);
        // the first background up from the widget, as the panel's own may be clear
        let back = null;
        for (let el = panel; el && clear(back); el = el.parentElement) {
            back = getComputedStyle(el).backgroundColor;
        }
        ctx.fillStyle = clear(back) ? '#ffffff' : back;
        ctx.fillRect(0, 0, box.width, box.height);

        // older browsers: laid out, and neither hidden nor see-through
        const shown = (el) => el.checkVisibility ?
            el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) :
            el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' &&
            parseFloat(getComputedStyle(el).opacity) > 0;
        const skip = '.link-handle, .close-handle, .edit-handle, .widget-image-skip, .ui-resizable-handle, i';
        const draw = (el, clip) => {
            if (el.matches(skip) || !shown(el)) {
                return;
            }
            const style = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const x = r.left - box.left, y = r.top - box.top;
            ctx.save();
            ctx.beginPath();
            ctx.rect(clip.x, clip.y, clip.w, clip.h);
            ctx.clip();
            const radius = parseFloat(style.borderTopLeftRadius) || 0;
            if (!clear(style.backgroundColor)) {
                ctx.fillStyle = style.backgroundColor;
                ctx.beginPath();
                ctx.roundRect ? ctx.roundRect(x, y, r.width, r.height, radius) : ctx.rect(x, y, r.width, r.height);
                ctx.fill();
            }
            const sides = ['Top', 'Right', 'Bottom', 'Left'].map(side => [
                parseFloat(style[`border${side}Width`]) || 0, style[`border${side}Color`], style[`border${side}Style`]
            ]);
            const line = ([width, color, kind]) => width > 0 && kind !== 'none' && !clear(color);
            if (sides.every(side => line(side) && side[0] === sides[0][0] && side[1] === sides[0][1])) {
                ctx.strokeStyle = sides[0][1];
                ctx.lineWidth = sides[0][0];
                const half = sides[0][0] / 2;
                ctx.beginPath();
                ctx.roundRect ? ctx.roundRect(x + half, y + half, r.width - 2 * half, r.height - 2 * half, radius) :
                    ctx.rect(x + half, y + half, r.width - 2 * half, r.height - 2 * half);
                ctx.stroke();
            } else {
                const [top, right, bottom, left] = sides;
                const strip = (side, sx, sy, sw, sh) => {
                    if (line(side)) {
                        ctx.fillStyle = side[1];
                        ctx.fillRect(sx, sy, sw, sh);
                    }
                };
                strip(top, x, y, r.width, top[0]);
                strip(right, x + r.width - right[0], y, right[0], r.height);
                strip(bottom, x, y + r.height - bottom[0], r.width, bottom[0]);
                strip(left, x, y, left[0], r.height);
            }
            if (el instanceof HTMLCanvasElement && el.width > 0 && el.height > 0) {
                ctx.drawImage(el, x, y, r.width, r.height);
            }
            // text word by word, so wrapped and spaced text lands where it shows
            ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            ctx.fillStyle = style.color;
            ctx.textBaseline = 'alphabetic';
            if ('letterSpacing' in ctx) {
                ctx.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
            }
            const range = document.createRange();
            el.childNodes.forEach((node) => {
                if (node.nodeType !== Node.TEXT_NODE) {
                    return;
                }
                for (const word of node.textContent.matchAll(/\S+/g)) {
                    range.setStart(node, word.index);
                    range.setEnd(node, word.index + word[0].length);
                    const rect = range.getClientRects()[0];
                    if (rect) {
                        const ascent = ctx.measureText(word[0]).fontBoundingBoxAscent ?? rect.height * 0.8;
                        ctx.fillText(word[0], rect.left - box.left, rect.top - box.top + ascent);
                    }
                }
            });
            ctx.restore();
            // children only show inside a box that cuts off what overflows it
            let inner = clip;
            if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
                const left = Math.max(clip.x, x), top = Math.max(clip.y, y);
                inner = {x: left, y: top, w: Math.max(0, Math.min(clip.x + clip.w, x + r.width) - left),
                    h: Math.max(0, Math.min(clip.y + clip.h, y + r.height) - top)};
            }
            Array.from(el.children).forEach(child => draw(child, inner));
        };
        draw(panel, {x: 0, y: 0, w: box.width, h: box.height});

        const blob = new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        try {
            // for pasting straight into a chat
            await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
        } catch (e) { /* not copied then, still saved */ }
        const stamp = new Date().toLocaleString('sv').replace(/:/g, '.');
        const title = $(`#${this.id}-title`).text().trim() || this.id;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(await blob);
        link.download = `${title} ${stamp}.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
        // a moment's tick on the button to say it's done
        if (button) {
            $(button).removeClass('fa-camera').addClass('fa-check');
            setTimeout(() => $(button).removeClass('fa-check').addClass('fa-camera'), 1500);
        }
    }

    sanitizeSelector(selector) {
        return String(selector).replace(/[:/.=+]/gi, '__');
    }

    startCommandTransition(id, $target) {
        /**
         * Note: this function works best wen applied to an element
         * inside a div with at least the following styles:
         *     display: flex;
         *     align-items: center;
         *     justify-content: center;
         */
        id = this.sanitizeSelector(id);
        let $container = $(`
            <span class="transition-icon-container">
                <i class="fa fa-fw fa-spinner fa-spin hide transition-spinner" id="spinner-${id}" style="font-size: 13px;"></i>
                <i class="fa fa-fw fa-check checkmark hide transition-check" id="check-${id}" style="font-size: 13px;"></i>
            </span>
        `);

        // Copy inline styles from target to container
        let inlineStyles = $target.attr('style');
        if (inlineStyles) {
            $container.attr('style', inlineStyles);
        }

        $target.before($container);
        $target.addClass('show');
        $target.toggleClass('show hide');
        $(`#spinner-${id}`).addClass('show');
        $target.prop('disabled', true);
    }

    async endCommandTransition(id, $target, success=true, hide=false) {
        id = this.sanitizeSelector(id);
        let $container = $target.prev('.transition-icon-container');
        let $spinner = $container.find(`#spinner-${id}`);
        let $check = $container.find(`#check-${id}`);

        return new Promise(resolve => {
            if (success) {
                setTimeout(() => {
                    $spinner.removeClass('show').addClass('hide');
                    $check.toggleClass('hide show');
                    setTimeout(() => {
                        $check.toggleClass('hide show');
                        $target.prop('disabled', false);
                        if (!hide) {
                            $target.toggleClass('show hide');
                        }
                        $container.remove();
                        resolve();
                    }, 500);
                }, 200);
            } else {
                if (!hide) {
                    $target.toggleClass('show hide');
                }
                $target.toggleClass('show hide');
                $target.prop('disabled', false);
                $spinner.removeClass('show').addClass('hide');
                $container.remove();
                resolve();
            }
        });
    }
}
