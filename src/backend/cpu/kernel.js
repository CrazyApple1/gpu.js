const {
	Kernel
} = require('../kernel');
const {
	FunctionBuilder
} = require('../function-builder');
const {
	CPUFunctionNode
} = require('./function-node');
const {
	utils
} = require('../../utils');
const {
	cpuKernelString
} = require('./kernel-string');

/**
 * @desc Kernel Implementation for CPU.
 * <p>Instantiates properties to the CPU Kernel.</p>
 */
class CPUKernel extends Kernel {
	static getFeatures() {
		return this.features;
	}
	static get features() {
		return Object.freeze({
			kernelMap: true,
			isIntegerDivisionAccurate: true
		});
	}
	static get isSupported() {
		return true;
	}
	static isContextMatch(context) {
		return false;
	}
	/**
	 * @desc The current mode in which gpu.js is executing.
	 */
	static get mode() {
		return 'cpu';
	}

	static nativeFunctionArguments() {
		return null;
	}

	static nativeFunctionReturnType() {
		return null;
	}

	static combineKernels(combinedKernel) {
		return combinedKernel;
	}

	constructor(source, settings) {
		super(source, settings);
		this.mergeSettings(source.settings || settings);

		this._imageData = null;
		this._colorData = null;
		this._kernelString = null;
		this.thread = {
			x: 0,
			y: 0,
			z: 0
		};
		this.translatedSources = null;
		this.run = function() { //note: need arguments
			this.run = null;
			this.build.apply(this, arguments);
			return this.run.apply(this, arguments);
		}.bind(this);
	}

	initCanvas() {
		if (typeof document !== 'undefined') {
			return document.createElement('canvas');
		} else if (typeof OffscreenCanvas !== 'undefined') {
			return new OffscreenCanvas(0, 0);
		}
	}

	initContext() {
		if (!this.canvas) return null;
		return this.canvas.getContext('2d');
	}

	initPlugins(settings) {
		return [];
	}

	/**
	 * @desc Validate settings related to CPU Kernel, such as
	 * dimensions size, and auto dimension support.
	 */
	validateSettings() {
		if (!this.output || this.output.length === 0) {
			if (arguments.length !== 1) {
				throw 'Auto dimensions only supported for kernels with only one input';
			}

			const argType = utils.getVariableType(arguments[0]);
			if (argType === 'Array') {
				this.output = utils.getDimensions(argType);
			} else if (argType === 'NumberTexture' || argType === 'ArrayTexture(4)') {
				this.output = arguments[0].output;
			} else {
				throw 'Auto dimensions not supported for input type: ' + argType;
			}
		}

		if (this.graphical) {
			if (this.output.length !== 2) {
				throw new Error('Output must have 2 dimensions on graphical mode');
			}
		}

		this.checkOutput();
	}

	translateSource() {
		const functionBuilder = FunctionBuilder.fromKernel(this, CPUFunctionNode);
		this.translatedSources = functionBuilder.getPrototypes('kernel');
		if (!this.graphical && !this.returnType) {
			this.returnType = functionBuilder.getKernelResultType();
		}
	}

	/**
	 * @desc Builds the Kernel, by generating the kernel
	 * string using thread dimensions, and arguments
	 * supplied to the kernel.
	 *
	 * <p>If the graphical flag is enabled, canvas is used.</p>
	 */
	build() {
		this.setupConstants();
		this.setupArguments(arguments);
		this.validateSettings();
		this.translateSource();

		if (this.graphical) {
			const {
				canvas,
				output
			} = this;
			if (!canvas) {
				throw new Error('no canvas available for using graphical output');
			}
			const width = output[0];
			const height = output[1] || 1;
			canvas.width = width;
			canvas.height = height;
			this._imageData = this.context.createImageData(width, height);
			this._colorData = new Uint8ClampedArray(width * height * 4);
		}

		const kernelString = this.getKernelString();
		this.kernelString = kernelString;

		if (this.debug) {
			console.log('Function output:');
			console.log(kernelString);
		}

		try {
			this.run = new Function([], kernelString).bind(this)();
		} catch (e) {
			console.error('An error occurred compiling the javascript: ', e);
		}
	}

	color(r, g, b, a) {
		if (typeof a === 'undefined') {
			a = 1;
		}

		r = Math.floor(r * 255);
		g = Math.floor(g * 255);
		b = Math.floor(b * 255);
		a = Math.floor(a * 255);

		const width = this.output[0];
		const height = this.output[1];

		const x = this.thread.x;
		const y = height - this.thread.y - 1;

		const index = x + y * width;

		this._colorData[index * 4 + 0] = r;
		this._colorData[index * 4 + 1] = g;
		this._colorData[index * 4 + 2] = b;
		this._colorData[index * 4 + 3] = a;
	}

	/**
	 * @desc Generates kernel string for this kernel program.
	 *
	 * <p>If sub-kernels are supplied, they are also factored in.
	 * This string can be saved by calling the `toString` method
	 * and then can be reused later.</p>
	 *
	 * @returns {String} result
	 *
	 */
	getKernelString() {
		if (this._kernelString !== null) return this._kernelString;

		let kernel = null;
		let {
			translatedSources
		} = this;
		if (translatedSources.length > 1) {
			translatedSources = translatedSources.filter(fn => {
				if (/^function/.test(fn)) return fn;
				kernel = fn;
				return false;
			})
		} else {
			kernel = translatedSources.shift();
		}
		const kernelString = this._kernelString = `
		const LOOP_MAX = ${ this._getLoopMaxString() }
		const constants = this.constants;
		const _this = this;
    return function (${ this.argumentNames.map(argumentName => 'user_' + argumentName).join(', ') }) {
      ${ this._processConstants() }
      ${ this._processArguments() }
      ${ this.graphical ? this._graphicalKernelBody(kernel) : this._resultKernelBody(kernel) }
      ${ translatedSources.length > 0 ? translatedSources.join('\n') : '' }
    }.bind(this);`;
		return kernelString;
	}

	/**
	 * @desc Returns the *pre-compiled* Kernel as a JS Object String, that can be reused.
	 */
	toString() {
		return cpuKernelString(this);
	}

	/**
	 * @desc Get the maximum loop size String.
	 * @returns {String} result
	 */
	_getLoopMaxString() {
		return (
			this.loopMaxIterations ?
			` ${ parseInt(this.loopMaxIterations) };\n` :
			' 1000;\n'
		);
	}

	_processConstants() {
		if (!this.constants) return '';

		const result = [];
		for (let p in this.constants) {
			const type = this.constantTypes[p];
			switch (type) {
				case 'HTMLImage':
					result.push(`  const constants_${p} = this._imageTo2DArray(this.constants.${p});`);
					break;
				case 'HTMLImageArray':
					result.push(`  const constants_${p} = this._imageTo3DArray(this.constants.${p});`);
					break;
				case 'Input':
					result.push(`  const constants_${p} = this.constants.${p}.value;`);
					break;
				default:
					result.push(`  const constants_${p} = this.constants.${p};`);
			}
		}
		return result.join('\n');
	}

	_processArguments() {
		const result = [];
		for (let i = 0; i < this.argumentTypes.length; i++) {
			switch (this.argumentTypes[i]) {
				case 'HTMLImage':
					result.push(`  user_${this.argumentNames[i]} = this._imageTo2DArray(user_${this.argumentNames[i]});`);
					break;
				case 'HTMLImageArray':
					result.push(`  user_${this.argumentNames[i]} = this._imageTo3DArray(user_${this.argumentNames[i]});`);
					break;
				case 'Input':
					result.push(`  user_${this.argumentNames[i]} = user_${this.argumentNames[i]}.value;`);
					break;
			}
		}
		return result.join(';\n');
	}

	_imageTo2DArray(image) {
		const canvas = this.canvas;
		if (canvas.width < image.width) {
			canvas.width = image.width;
		}
		if (canvas.height < image.height) {
			canvas.height = image.height;
		}
		const ctx = this.context;
		ctx.drawImage(image, 0, 0, image.width, image.height);
		const pixelsData = ctx.getImageData(0, 0, image.width, image.height).data;
		const imageArray = new Array(image.height);
		let index = 0;
		for (let y = image.height - 1; y >= 0; y--) {
			const row = imageArray[y] = new Array(image.width);
			for (let x = 0; x < image.width; x++) {
				const pixel = new Float32Array(4);
				pixel[0] = pixelsData[index++] / 255; // r
				pixel[1] = pixelsData[index++] / 255; // g
				pixel[2] = pixelsData[index++] / 255; // b
				pixel[3] = pixelsData[index++] / 255; // a
				row[x] = pixel;
			}
		}
		return imageArray;
	}

	getPixels() {
		// https://stackoverflow.com/a/41973289/1324039
		const [width, height] = this.output;
		const halfHeight = height / 2 | 0; // the | 0 keeps the result an int
		const bytesPerRow = width * 4;
		// make a temp buffer to hold one row
		const temp = new Uint8Array(width * 4);
		const pixels = this._imageData.data.slice(0);
		for (let y = 0; y < halfHeight; ++y) {
			var topOffset = y * bytesPerRow;
			var bottomOffset = (height - y - 1) * bytesPerRow;

			// make copy of a row on the top half
			temp.set(pixels.subarray(topOffset, topOffset + bytesPerRow));

			// copy a row from the bottom half to the top
			pixels.copyWithin(topOffset, bottomOffset, bottomOffset + bytesPerRow);

			// copy the copy of the top half row to the bottom half
			pixels.set(temp, bottomOffset);
		}
		return pixels;
	}

	_imageTo3DArray(images) {
		const imagesArray = new Array(images.length);
		for (let i = 0; i < images.length; i++) {
			imagesArray[i] = this._imageTo2DArray(images[i]);
		}
		return imagesArray;
	}

	_resultKernelBody(kernelString) {
		switch (this.output.length) {
			case 1:
				return this._resultKernel1DLoop(kernelString) + this._kernelOutput();
			case 2:
				return this._resultKernel2DLoop(kernelString) + this._kernelOutput();
			case 3:
				return this._resultKernel3DLoop(kernelString) + this._kernelOutput();
			default:
				throw new Error('unsupported size kernel');
		}
	}

	_graphicalKernelBody(kernelString) {
		switch (this.output.length) {
			case 2:
				return this._graphicalKernel2DLoop(kernelString) + this._graphicalOutput();
			default:
				throw new Error('unsupported size kernel');
		}
	}

	_graphicalOutput() {
		return `
    this._imageData.data.set(this._colorData);
    this.context.putImageData(this._imageData, 0, 0);
    return;`
	}

	_getKernelResultTypeConstructorString() {
		switch (this.returnType) {
			case 'LiteralInteger':
			case 'Number':
			case 'Integer':
			case 'Float':
				return 'Float32Array';
			case 'Array(2)':
			case 'Array(3)':
			case 'Array(4)':
				return 'Array';
			default:
				if (this.graphical) {
					return 'Float32Array';
				}
				throw new Error(`unhandled returnType ${ this.returnType }`);
		}
	}

	_resultKernel1DLoop(kernelString) {
		const {
			output
		} = this;
		const constructorString = this._getKernelResultTypeConstructorString();
		return `const result = new ${constructorString}(${ output[0] });
    ${ this._mapSubKernels(subKernel => `let subKernelResult_${ subKernel.name };`).join('\n') }
		${ this._mapSubKernels(subKernel => `const result_${ subKernel.name } = new ${constructorString}(${ output[0] });\n`).join('') }
    for (let x = 0; x < ${ output[0] }; x++) {
      this.thread.x = x;
      this.thread.y = 0;
      this.thread.z = 0;
      let kernelResult;
      ${ kernelString }
      result[x] = kernelResult;
      ${ this._mapSubKernels(subKernel => `result_${ subKernel.name }[x] = subKernelResult_${ subKernel.name };\n`).join('') }
    }`;
	}

	_resultKernel2DLoop(kernelString) {
		const {
			output
		} = this;
		const constructorString = this._getKernelResultTypeConstructorString();
		return `const result = new Array(${ output[1] });
		${ this._mapSubKernels(subKernel => `let subKernelResult_${ subKernel.name };`).join('\n') }
    ${ this._mapSubKernels(subKernel => `const result_${ subKernel.name } = new Array(${ output[1] });\n`).join('') }
    for (let y = 0; y < ${ output[1] }; y++) {
      this.thread.z = 0;
      this.thread.y = y;
      const resultX = result[y] = new ${constructorString}(${ output[0] });
      ${ this._mapSubKernels(subKernel => `const result_${ subKernel.name }X = result_${subKernel.name}[y] = new ${constructorString}(${ output[0] });\n`).join('') }
      for (let x = 0; x < ${ output[0] }; x++) {
      	this.thread.x = x;
        let kernelResult;
        ${ kernelString }
        resultX[x] = kernelResult;
        ${ this._mapSubKernels(subKernel => `result_${ subKernel.name }X[x] = subKernelResult_${ subKernel.name };\n`).join('') }
      }
    }`;
	}

	_graphicalKernel2DLoop(kernelString) {
		const {
			output
		} = this;
		const constructorString = this._getKernelResultTypeConstructorString();
		return `${ this._mapSubKernels(subKernel => `let subKernelResult_${ subKernel.name };`).join('\n') }
    ${ this._mapSubKernels(subKernel => `const result_${ subKernel.name } = new Array(${ output[1] });\n`).join('') }
    for (let y = 0; y < ${ output[1] }; y++) {
      this.thread.z = 0;
      this.thread.y = y;
      ${ this._mapSubKernels(subKernel => `const result_${ subKernel.name }X = result_${subKernel.name}[y] = new ${constructorString}(${ output[0] });\n`).join('') }
      for (let x = 0; x < ${ output[0] }; x++) {
      	this.thread.x = x;
        ${ kernelString }
        ${ this._mapSubKernels(subKernel => `result_${ subKernel.name }X[x] = subKernelResult_${ subKernel.name };\n`).join('') }
      }
    }`;
	}

	_resultKernel3DLoop(kernelString) {
		const {
			output
		} = this;
		const constructorString = this._getKernelResultTypeConstructorString();
		return `const result = new Array(${ output[2] });
    ${ this._mapSubKernels(subKernel => `let subKernelResult_${ subKernel.name };`).join('\n') }
    ${ this._mapSubKernels(subKernel => `const result_${ subKernel.name } = new Array(${ output[2] });\n`).join('') }
    for (let z = 0; z < ${ output[2] }; z++) {
      this.thread.z = z;
      const resultY = result[z] = new Array(${ output[1] });
      ${ this._mapSubKernels(subKernel => `const result_${ subKernel.name }Y = result_${subKernel.name}[z] = new Array(${ output[1] });\n`).join('') }
      for (let y = 0; y < ${ output[1] }; y++) {
        this.thread.y = y;
        const resultX = resultY[y] = new ${constructorString}(${ output[0] });
        ${ this._mapSubKernels(subKernel => `const result_${ subKernel.name }X = result_${subKernel.name}Y[y] = new ${constructorString}(${ output[0] });\n`).join('') }
        for (let x = 0; x < ${ output[0] }; x++) {
        	this.thread.x = x;
          let kernelResult;
          ${ kernelString }
          resultX[x] = kernelResult;
          ${ this._mapSubKernels(subKernel => `result_${ subKernel.name }X[x] = subKernelResult_${ subKernel.name };\n`).join('') }
        }
      }
    }`;
	}

	_kernelOutput() {
		if (!this.subKernels) {
			return 'return result;';
		}
		return `return {
      result: result,
      ${ this.subKernels.map(subKernel => `${ subKernel.property }: result_${ subKernel.name }`).join(',\n') }
    };`;
	}

	_mapSubKernels(fn) {
		return this.subKernels === null ? [''] :
			this.subKernels.map(fn);
	}



	destroy(removeCanvasReference) {
		if (removeCanvasReference) {
			delete this.canvas;
		}
	}

	static destroyContext(context) {}

	toJSON() {
		const json = super.toJSON();
		json.functionNodes = FunctionBuilder.fromKernel(this, CPUFunctionNode).toJSON();
		return json;
	}
}

module.exports = {
	CPUKernel
};