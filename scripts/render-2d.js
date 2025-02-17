"use strict";


// Viewport state

var state = {
    name: "",
    width: window.innerWidth,
    height: window.innerHeight,
    xmin: NaN,
    xmax: NaN,
    ymin: NaN,
    ymax: NaN,
    renderNeeded: true
};
function resetState(loaded_state = {}, overwrite = true) {
    var state1 = {
        name: state.name,
        width: window.innerWidth,
        height: window.innerHeight,
        renderNeeded: true
    };
    var xym = calcXyMinMax();
    for (var key in xym) state1[key] = xym[key];
    for (var key in state1) {
        if (overwrite || loaded_state[key] == undefined)
            loaded_state[key] = state1[key];
        state[key] = loaded_state[key];
    }
}

// calculate the center of the screen excluding the control box
function calcScreenCenter() {
    let rect = document.getElementById("control").getBoundingClientRect();
    var w = window.innerWidth, h = window.innerHeight;
    var rl = rect.left, rb = h - rect.bottom;
    var cx = 0.5 * w, cy = 0.5 * h;
    if (rl > rb && rl > 0) cx = 0.5 * rl;
    else if (rb > 0) cy = 0.5 * rb;
    var com = { x: 2.0 * (cx / w - 0.5), y: 2.0 * (cy / h - 0.5) };
    com.x = 0.5 + 0.5 * Math.max(-0.6, Math.min(0.6, com.x));
    com.y = 0.5 + 0.5 * Math.max(-0.6, Math.min(0.6, com.y));
    return com;
}
// calculate the default bound points
function calcXyMinMax() {
    var center = calcScreenCenter();
    var w = window.innerWidth, h = window.innerHeight;
    var sc = 2.5 / Math.min(w, h);
    return {
        xmin: -center.x * (2.0 * sc * w),
        xmax: (1.0 - center.x) * (2.0 * sc * w),
        ymin: -center.y * (2.0 * sc * h),
        ymax: (1.0 - center.y) * (2.0 * sc * h)
    };
}

// mouse/wheel interactions
function translateState(movementXy) {
    var dx = movementXy.x / state.width * (state.xmax - state.xmin);
    var dy = -movementXy.y / state.height * (state.ymax - state.ymin);
    state.xmin -= dx, state.xmax -= dx;
    state.ymin -= dy, state.ymax -= dy;
}
// scale the viewport about a point on the graph
function scaleState(mouseXy, sc) {
    if (typeof sc == 'number') sc = { x: sc, y: sc };
    var x = state.xmin + (state.xmax - state.xmin) * mouseXy.x / state.width;
    var y = state.ymin + (state.ymax - state.ymin) * (1.0 - mouseXy.y / state.height);
    state.xmin = x + (state.xmin - x) * sc.x;
    state.xmax = x + (state.xmax - x) * sc.x;
    state.ymin = y + (state.ymin - y) * sc.y;
    state.ymax = y + (state.ymax - y) * sc.y;
}
// call this after window resizing
function resizeState() {
    var width = window.innerWidth, height = window.innerHeight;
    if (!((state.xmax - state.xmin) * (state.ymax - state.ymin) > 0)) {
        var sc = Math.sqrt(width * height);
        state.xmin = -(state.xmax = 10. * width / sc);
        state.ymin = -(state.ymax = 10. * height / sc);
    }
    else if (width > 50 && height > 50 && state.width > 50 && state.height > 50) {
        var sc = Math.sqrt(state.width * state.height) / Math.sqrt(width * height);
        var c = calcScreenCenter();
        var ratio = ((state.ymax - state.ymin) / state.height)
            / ((state.xmax - state.xmin) / state.width);  // keep aspect ratio after floating point accuracy loss
        scaleState(
            { x: c.x * state.width, y: c.y * state.height },
            {
                x: sc * width / state.width * Math.sqrt(ratio),
                y: sc * height / state.height / Math.sqrt(ratio)
            }
        );
    }
    state.width = width, state.height = height;
}

// render legend
function renderLegend() {
    var scale = state.width / (state.xmax - state.xmin);
    const targetWidth = 120;
    var targetL = targetWidth / scale;
    var expi = Math.floor(Math.log10(targetL));
    var l = Math.pow(10, expi);
    if (l / targetL < 0.2) l *= 5.0;
    if (l / targetL < 0.5) l *= 2.0;
    document.getElementById("legend-scale").setAttribute("width", scale * l);
    document.getElementById("legend-text").setAttribute("x", 0.5 * scale * l);
    function toSuperscript(num) {
        num = "" + num;
        var res = "";
        for (var i = 0; i < num.length; i++) {
            if (num[i] == "-") res += "⁻";
            else res += "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(num[i])];
        }
        return res;
    }
    if (l >= 1e4 || l < 1e-3)
        l = Math.round(l * Math.pow(10, -expi)) + "×10" + toSuperscript(expi);
    document.getElementById("legend-text").textContent = l;
}


// Rendering

var renderer = {
    canvas: null,
    gl: null,
    vsSource: "",
    shaderSource: "",
    positionBuffer: null,
    shaderProgram: null,
    enableAntiAliasing: false,
    antiAliaser: null,
    timerExt: null,
};

// call this function to re-render
async function drawScene(state) {
    if (renderer.shaderProgram == null) {
        renderer.canvas.style.cursor = "not-allowed";
        return;
    }
    else renderer.canvas.style.cursor = "default";
    let gl = renderer.gl;
    let antiAliaser = renderer.antiAliaser;

    // set position buffer for vertex shader
    function setPositionBuffer(program) {
        var vpLocation = gl.getAttribLocation(program, "vertexPosition");
        const numComponents = 2; // pull out 2 values per iteration
        const type = gl.FLOAT; // the data in the buffer is 32bit floats
        const normalize = false; // don't normalize
        const stride = 0; // how many bytes to get from one set of values to the next
        const offset = 0; // how many bytes inside the buffer to start from
        gl.bindBuffer(gl.ARRAY_BUFFER, renderer.positionBuffer);
        gl.vertexAttribPointer(
            vpLocation,
            numComponents, type, normalize, stride, offset);
        gl.enableVertexAttribArray(vpLocation);
    }

    // render to target + timer
    var timerQueries = [];
    let timer = renderer.timerExt;
    const countIndividualTime = false;
    function renderPass() {
        if (countIndividualTime && timer != null) {
            let query = gl.createQuery();
            timerQueries.push(query);
            gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.endQuery(timer.TIME_ELAPSED_EXT);
        }
        else gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    let query = null;
    if (!countIndividualTime && timer != null) {
        query = gl.createQuery();
        timerQueries.push(query);
        gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    }

    // clear the canvas
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // render image
    gl.viewport(0, 0, state.width, state.height);
    gl.useProgram(renderer.shaderProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER,
        renderer.enableAntiAliasing ? antiAliaser.renderFramebuffer : null);
    setPositionBuffer(renderer.shaderProgram);
    gl.uniform2f(gl.getUniformLocation(renderer.shaderProgram, "iResolution"), state.width, state.height);
    gl.uniform2f(gl.getUniformLocation(renderer.shaderProgram, "xyMin"), state.xmin, state.ymin);
    gl.uniform2f(gl.getUniformLocation(renderer.shaderProgram, "xyMax"), state.xmax, state.ymax);
    gl.uniform1f(gl.getUniformLocation(renderer.shaderProgram, "rBrightness"), state.rBrightness);
    renderPass();

    if (renderer.enableAntiAliasing) {
        // render image gradient
        gl.useProgram(antiAliaser.imgGradProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, antiAliaser.imgGradFramebuffer);
        setPositionBuffer(antiAliaser.imgGradProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, antiAliaser.renderTexture);
        gl.uniform1i(gl.getUniformLocation(antiAliaser.imgGradProgram, "iChannel0"), 0);
        renderPass();

        // render anti-aliasing
        gl.useProgram(antiAliaser.aaProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        setPositionBuffer(antiAliaser.aaProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, antiAliaser.renderTexture);
        gl.uniform1i(gl.getUniformLocation(antiAliaser.aaProgram, "iChannel0"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, antiAliaser.imgGradTexture);
        gl.uniform1i(gl.getUniformLocation(antiAliaser.aaProgram, "iChannel1"), 1);
        renderPass();
    }

    if (!countIndividualTime && timer != null)
        gl.endQuery(timer.TIME_ELAPSED_EXT);

    // check timer
    function checkTime() {
        if (timerQueries.length == 0) return;
        if (timer == null) {
            for (var i = 0; i < timerQueries.length; i++)
                gl.deleteQuery(timerQueries[i]);
            return;
        }
        let query = timerQueries[timerQueries.length - 1];
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
            setTimeout(checkTime, 40);
            return;
        }
        var indivTime = [], totTime = 0.0;
        for (var i = 0; i < timerQueries.length; i++) {
            let query = timerQueries[i];
            if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
                let dt = 1e-6 * gl.getQueryParameter(query, gl.QUERY_RESULT);
                indivTime.push(dt.toFixed(1) + "ms");
                totTime += dt;
            }
            gl.deleteQuery(query);
        }
        if (countIndividualTime) console.log(indivTime.join(' '));
        document.getElementById("fps").textContent = (1000.0 / totTime).toFixed(1) + " fps";
    }
    setTimeout(checkTime, 100);
}


// ============================ MAIN ==============================

function initWebGL() {
    // get context
    renderer.canvas = document.getElementById("canvas");
    renderer.gl = canvas.getContext("webgl2") || canvas.getContext("experimental-webgl2");
    if (renderer.gl == null)
        throw ("Error: Your browser may not support WebGL2, which is required to run this tool.<br/>It is recommended to use a Chrome-based browser on a desktop device with an updated graphics driver.");
    canvas.addEventListener("webglcontextlost", function (event) {
        event.preventDefault();
        document.body.innerHTML = "<h1 style='color:red;'>Error: WebGL context lost. Please refresh this page.</h1>";
    });

    // load GLSL source
    console.time("load glsl code");
    renderer.vsSource = "#version 300 es\nin vec4 vertexPosition;out vec2 vXy;" +
        "void main(){vXy=vertexPosition.xy;gl_Position=vertexPosition;}";
    renderer.shaderSource = getShaderSource("frag-shader.glsl");
    console.timeEnd("load glsl code");

    // position buffer
    renderer.positionBuffer = renderer.gl.createBuffer();
    renderer.gl.bindBuffer(renderer.gl.ARRAY_BUFFER, renderer.positionBuffer);
    var positions = [-1, 1, 1, 1, -1, -1, 1, -1];
    renderer.gl.bufferData(renderer.gl.ARRAY_BUFFER, new Float32Array(positions), renderer.gl.STATIC_DRAW);

    // timer
    renderer.timerExt = renderer.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (renderer.timerExt)
        document.getElementById("fps").textContent = "Timer loaded.";
    else {
        document.getElementById("fps").style.display = "none";
        console.warn("Timer unavailable.");
    }

    // state
    try {
        var initialState = localStorage.getItem(state.name);
        if (initialState != null) {
            var new_state = JSON.parse(initialState);
            resetState(new_state, false);
        }
        else resetState();
    }
    catch (e) {
        console.error(e);
        try { localStorage.removeItem(state.name); } catch (e) { console.error(e); }
    }
}

function updateBuffers() {
    state.width = canvas.width = canvas.style.width = window.innerWidth;
    state.height = canvas.height = canvas.style.height = window.innerHeight;

    let gl = renderer.gl;
    var oldAntiAliaser = renderer.antiAliaser;
    renderer.antiAliaser = createAntiAliaser(gl, state.width, state.height);
    if (oldAntiAliaser) destroyAntiAliaser(gl, oldAntiAliaser);

    state.renderNeeded = true;
}

// Initialize renderer, call updateShaderFunction() once before calling this
function initRenderer() {
    let canvas = renderer.canvas;
    let gl = renderer.gl;

    updateBuffers();

    // rendering
    var oldScreenCenter = [-1, -1];
    function render() {
        var screenCenter = calcScreenCenter();
        state.screenCenter = screenCenter;
        if ((screenCenter[0] != oldScreenCenter[0] || screenCenter[1] != oldScreenCenter[1])
            || state.renderNeeded) {
            resizeState();
            state.width = canvas.width = canvas.style.width = window.innerWidth;
            state.height = canvas.height = canvas.style.height = window.innerHeight;
            try {
                localStorage.setItem(state.name, JSON.stringify(state));
            } catch (e) { console.error(e); }
            drawScene(state);
            renderLegend();
            state.renderNeeded = false;
        }
        oldScreenCenter = screenCenter;
        requestAnimationFrame(render);
    }
    requestAnimationFrame(render);

    // interactions
    var fingerDist = -1;
    canvas.addEventListener("wheel", function (event) {
        if (renderer.shaderProgram == null)
            return;
        resizeState();
        scaleState(
            { x: event.clientX, y: event.clientY },
            Math.exp(-0.0004 * event.wheelDeltaY)
        );
        state.renderNeeded = true;
    }, { passive: true });
    var mouseDown = false;
    canvas.addEventListener("pointerdown", function (event) {
        //event.preventDefault();
        document.getElementById("help-menu").style.visibility = "hidden";
        canvas.setPointerCapture(event.pointerId);
        mouseDown = true;
    });
    window.addEventListener("pointerup", function (event) {
        event.preventDefault();
        mouseDown = false;
    });
    canvas.addEventListener("pointermove", function (event) {
        if (renderer.shaderProgram == null)
            return;
        if (mouseDown) {
            var v = fingerDist == -1 ? 1.0 : 0.4;
            translateState({ x: v * event.movementX, y: v * event.movementY });
            state.renderNeeded = true;
        }
    });
    canvas.addEventListener("touchstart", function (event) {
        if (event.touches.length == 2) {
            var fingerPos0 = [event.touches[0].pageX, event.touches[0].pageY];
            var fingerPos1 = [event.touches[1].pageX, event.touches[1].pageY];
            fingerDist = Math.hypot(fingerPos1[0] - fingerPos0[0], fingerPos1[1] - fingerPos0[1]);
        }
    }, { passive: true });
    canvas.addEventListener("touchend", function (event) {
        fingerDist = -1.0;
    }, { passive: true });
    canvas.addEventListener("touchmove", function (event) {
        if (renderer.shaderProgram == null)
            return;
        if (event.touches.length == 2) {
            var fingerPos0 = { x: event.touches[0].pageX, y: event.touches[0].pageY };
            var fingerPos1 = { x: event.touches[1].pageX, y: event.touches[1].pageY };
            var newFingerDist = Math.hypot(fingerPos1.x - fingerPos0.x, fingerPos1.y - fingerPos0.y);
            if (fingerDist > 0. && newFingerDist > 0.) {
                var sc = fingerDist / newFingerDist;
                scaleState({
                    x: 0.5 * (fingerPos0.x + fingerPos1.x),
                    y: 0.5 * (fingerPos0.y + fingerPos1.y)
                }, sc);
            }
            fingerDist = newFingerDist;
            state.renderNeeded = true;
        }
    }, { passive: true });
    window.addEventListener("resize", function () {
        resizeState();
        updateBuffers();
    });

}

function updateShaderFunction(funCode, funGradCode, params) {
    let gl = renderer.gl;

    function sub(shaderSource) {
        shaderSource = shaderSource.replaceAll("{%FUN%}", funCode);
        shaderSource = shaderSource.replaceAll("{%FUNGRAD%}", funGradCode);
        shaderSource = shaderSource.replaceAll("{%GRID%}", params.bGrid ? "1" : "0");
        shaderSource = shaderSource.replaceAll("{%CONTOUR_LINEAR%}", params.bContourLinear ? "1" : "0");
        shaderSource = shaderSource.replaceAll("{%CONTOUR_LOG%}", params.bContourLog ? "1" : "0");
        return shaderSource;
    }
    console.time("compile shader");

    // shader program(s)
    if (renderer.shaderProgram != null) {
        gl.deleteProgram(renderer.shaderProgram);
        renderer.shaderProgram = null;
    }
    if (funCode != null) {
        try {
            var shaderSource = sub(renderer.shaderSource, funCode, funGradCode);
            var shaderProgram = createShaderProgram(gl, renderer.vsSource, shaderSource);
            renderer.shaderProgram = shaderProgram;
        }
        catch (e) { console.error(e); }
    }

    console.timeEnd("compile shader");
    state.renderNeeded = true;
}