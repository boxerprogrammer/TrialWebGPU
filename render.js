(async () => {
	//そもそもWebGPU対応のブラウザか？
    if (navigator.gpu === undefined) {
		alert("WebGPU is not supported/enabled in your browser");
        return;
    }

    // 現在のグラボはWebGPUに対応しているか？
    var adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
		alert("Your GPU is WebGPU not supported");
        return;
    }
	//WebGPUに対応しているなら、デバイスオブジェクトの取得
	//DirectXにおけるdeviceと同じ概念と思われる
    var device = await adapter.requestDevice();

    //描画先の指定。Webブラウザの場合はDirectXとかと違ってウィンドウハンドルではなく
	//ブラウザ上に指定された"Canvas"からコンテキストを取得する。
    var canvas = document.getElementById("webgpu-canvas");
    var context = canvas.getContext("webgpu");

	//シェーダコード
    var shaderCode =`
    alias float4 = vec4<f32>; //vec4<f32>と書くのは面倒なのでfloat4と別名をつけておく
    struct VertexInput {//頂点シェーダ
        @location(0) position: float4,//@locationというのは今後も出てくる「属性」を表している
        @location(1) color: float4,//名前から予想はつくが元々は位置情報を想定して渡されたものです。座標情報ではなく、データの位置を表しています
    };

    struct VertexOutput {
        @builtin(position) position: float4,//はい出たbuiltin属性…恐らくはhlslの時のSV_にあたるやつ
        @location(0) color: float4,
    };
	
    @vertex//恐らくこれがvertexシェーダの合図
    fn vertex_main(vert: VertexInput) -> VertexOutput {
        var out: VertexOutput;
        out.color = vert.color;
        out.position = vert.position;
        return out;
    };

    @fragment//そしてこれがピクセルシェーダの合図
    fn fragment_main(in: VertexOutput) -> @location(0) float4 {
        return float4(in.color);
    }
    `;

    // シェーダ文字列からシェーダモジュールオブジェクトを作成
    var shaderModule = device.createShaderModule({code: shaderCode});
    //コンパイル時に取得したデータから、情報を受け取る
    var compilationInfo = await shaderModule.getCompilationInfo();
    //なんかしらメッセージが返ってきたらエラーが起きてたという事
    if (compilationInfo.messages.length > 0) {//エラーが起きてたら、エラー時の処理
        var hadError = false;
        console.log("Shader compilation log:");
        for (var i = 0; i < compilationInfo.messages.length; ++i) {
            var msg = compilationInfo.messages[i];
            console.log(`${msg.lineNum}:${msg.linePos} - ${msg.message}`);
            hadError = hadError || msg.type == "error";
        }
        if (hadError) {
            console.log("Shader failed to compile");
            return;
        }
    }

    // 頂点バッファの作成
    var dataBuf = device.createBuffer({
        size: 3 * 2 * 4 * 4,
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true,
    });
    // 頂点座標情報と色情報をマップ
    new Float32Array(dataBuf.getMappedRange()).set([
         1.0, -1.0, 0.0, 1.0,  1.0, 0.0, 0.0, 1.0, //xyzw rgba
        -1.0, -1.0, 0.0, 1.0,  0.0, 1.0, 0.0, 1.0, 
         0.0,  1.0, 0.0, 1.0,  0.0, 0.0, 1.0, 1.0,
    ]);
    dataBuf.unmap();

    // 所謂頂点レイアウトを設定する
    var vertexState = {
        module: shaderModule,//既に作っておいたシェーダモジュール
        entryPoint: "vertex_main",//エントリポイントとして使う頂点シェーダ関数
        buffers: [{
            arrayStride: 2 * 4 * 4,
            attributes: [
                {format: "float32x4", offset: 0, shaderLocation: 0},//この辺のオフセット計算、-1とかいれたら自動計算してくれへんのかな…
                {format: "float32x4", offset: 4 * 4, shaderLocation: 1}
            ]
        }]
    };

    // レンダリング設定
    var swapChainFormat = "bgra8unorm";//スワップチェーン(画面のバッファ)フォーマットはBGRA_8UNORM←8bit符号なし正規化(0.0～1.0のこと)
    context.configure(
        {
            //ややこしいんだが、左が「コンテキストの決めるべき項目」
            device: device, //デバイス
            format: swapChainFormat, //画面(レンダリング先：バックバッファ)フォーマット
            usage: GPUTextureUsage.RENDER_ATTACHMENT//定数：レンダ―ターゲットって意味だろう
            //https://developer.mozilla.org/en-US/docs/Web/API/GPUTexture/usage
        }
    );

    //デプスバッファも作っておく
    var depthFormat = "depth24plus-stencil8";
    var depthTexture = device.createTexture({
        size: {width: canvas.width, height: canvas.height, depth: 1.0},
        format: depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT
    });

    // ピクセルシェーダステート(ピクセルシェーダオブジェクト)を作る
    var fragmentState = {
        module: shaderModule,//シェーダモジュール
        entryPoint: "fragment_main",//ピクセルシェーダ関数名
        targets: [{format: swapChainFormat}]//書き出す先のフォーマット情報
    };

    // 所謂レンダリングパイプラインオブジェクトを作る
    //ここのレイアウトは、DX12の「頂点レイアウト」ではなく、「ルートシグネチャ」にあたると思われる
    //今回はCBVもSRVもないため、空でOK
    var layout = device.createPipelineLayout({bindGroupLayouts: []});
    //で、
    var renderPipeline = device.createRenderPipeline({
        layout: layout,
        vertex: vertexState,
        fragment: fragmentState,
        depthStencil: {format: depthFormat, depthWriteEnabled: true, depthCompare: "less"}
    });

    //レンダ―ターゲットビューを毎フレーム設定している部分
    //どうクリアするのか、などの設定を定義している
    //この時点ではGPUに何の命令も出していない。ただ単に情報の構造体を作ってるだけ
    var renderPassDesc = {
        colorAttachments: [{
            view: undefined,
            loadOp: "clear",
            loadValue: [0.3, 0.3, 0.3, 1],
            storeOp: "store"
        }],
        depthStencilAttachment: {
            view: depthTexture.createView(),
            depthLoadOp: "clear",
            depthClearValue: 1.0,
            depthStoreOp: "store",
            stencilLoadOp: "clear",
            stencilClearValue: 0,
            stencilStoreOp: "store"
        }
    };

    // Not covered in the tutorial: track when the canvas is visible
    // on screen, and only render when it is visible.
    var canvasVisible = false;
    //交差オブザーバーAPIのインターフェースオブジェクトを生成
    //https://developer.mozilla.org/ja/docs/Web/API/Intersection_Observer_API
    //https://developer.mozilla.org/ja/docs/Web/API/IntersectionObserver/IntersectionObserver
    var observer = new IntersectionObserver(function(e) {
        if (e[0].isIntersecting) {
            canvasVisible = true;
        } else {
            canvasVisible = false;
        }
    }, {threshold: [0]});

    //キャンバスの状況を監視。ここでは1pxでも交差領域に入ったら表示されたと見做している
    observer.observe(canvas);

    //毎フレーム実行される関数
    var frame = function() {
        if (canvasVisible) {
            renderPassDesc.colorAttachments[0].view = context.getCurrentTexture().createView();

            var commandEncoder = device.createCommandEncoder();

            var renderPass = commandEncoder.beginRenderPass(renderPassDesc);

            renderPass.setPipeline(renderPipeline);
            renderPass.setVertexBuffer(0, dataBuf);
            renderPass.draw(3, 1, 0, 0);

            renderPass.end();
            device.queue.submit([commandEncoder.finish()]);
        }
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
})();
