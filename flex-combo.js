var http = require('http')
, fs = require('fs')
, path = require('path')
, isUtf8 = require('is-utf8')
, iconv = require('iconv-lite')
, util = require('util')
, joinbuffers = require('joinbuffers')
, mkdirp = require('mkdirp')
, crypto = require('crypto')
, parse = require('url').parse 
, mime = require('mime');

/**
  Yahoo Combo:
  <script src="http://yui.yahooapis.com/combo 
  ?2.5.2/build/editor/editor-beta-min.js 
  &2.5.2/build/yahoo-dom-event/yahoo-dom-event.js 
  &2.5.2/build/container/container_core-min.js 
  &2.5.2/build/menu/menu-min.js 
  &2.5.2/build/element/element-beta-min.js 
  &2.5.2/build/button/button-min.js"> 
  </script>

//淘宝combo server规则a.tbcdn.cn/apps??
*/
var param = {
    urls: {},
    host : 'assets.taobaocdn.com',
    servlet : '?',
    seperator: ',',
    charset: 'gbk',
    filter : {
        '\\?t=.+':'',
        '-min\\.js$':'.js'
    },
    supportedFile: '\\.js|\\.css|\\.png|\\.gif|\\.jpg|\\.swf|\\.xml|\\.less',
    prjDir: ''
}; 

function adaptCharset(buff, outCharset, charset){
    if (charset === outCharset) {
        return buff;
    }

    return iconv.encode(iconv.decode(buff, charset), outCharset);    
}

function filterUrl(url){
    var filter = param.filter;
    var filtered = url;
    for(var fk in filter){
        filtered = filtered.replace(new RegExp(fk), filter[fk]);
    }
    return filtered;
}

function isBinFile(fileName){
    return !/.js$|.css$|.less$/.test(fileName);
}
/*
 * 根据一个文件的全路径(如：/xxx/yyy/aa.js)从本地文件系统获取内容
 */
function readFromLocal (fullPath) {
    console.log('local file:'+ fullPath);
    var map = param.urls,  charset = param.charset;
    fullPath = filterUrl(fullPath);
    var longestMatchNum = -1 , longestMatchPos = null;
    for(k in map){
        if(fullPath.replace(/\\/g, '/').indexOf(k) === 0 && longestMatchNum < k.length){
            longestMatchNum = k.length;
            longestMatchPos = k;
        }
    }
    if(!longestMatchPos){ return null }

    var dirs = map[longestMatchPos].split(',');
    for (var i = 0, len = dirs.length; i < len; i++){
        var dir = dirs[i];
        var revPath = fullPath.slice(longestMatchPos.length, fullPath.length);
        var absPath = path.normalize(path.join(param.prjDir, dir, revPath));
        console.log('read file:'+ absPath);
        if(fs.existsSync(absPath)){
            var buff = fs.readFileSync(absPath);
            if(isBinFile(absPath)){
                return buff;
            }
            var charset = isUtf8(buff) ? 'utf8' : 'gbk';
            return adaptCharset(buff, param.charset, charset);
        }
    }
    return null;
}

var merge = function(dest, src) {
    for (var i in src) {
        dest[i] = src[i];
    }
    return dest;
}

var cacheFile = function(fullPath, content, encode){
    var absPath = path.join(param.cacheDir, fullPath);
    var lastDir = absPath.slice(0, absPath.lastIndexOf('/'));
    console.log(lastDir);
    if(!fs.existsSync(lastDir)){
        console.log(' is not exist');
        mkdirp(lastDir, function(){
            fs.writeFileSync(absPath, content, encode);
        });
        return;
    }
    fs.writeFileSync(absPath, content, encode);
}

var readFromCache = function(fullPath){
    var absPath = path.join(param.cacheDir, fullPath);
    if(fs.existsSync(absPath)){
        var buff = fs.readFileSync(absPath);
        if(isBinFile(absPath)){
            return buff;
        }
        var charset = isUtf8(buff) ? 'utf8' : 'gbk';
        return adaptCharset(buff, param.charset, charset);
    }
    return null;
}

exports = module.exports = function(prjDir, urls, options){
    if(urls){
        param.urls = merge(param.urls, urls);
    }
    var userHome = process.env.HOME || process.env.HOMEPATH;//兼容windows
    param.cacheDir = cacheDir = path.join(userHome, '.flex-combo/cache');
    if(!fs.existsSync(cacheDir)){
        mkdirp(cacheDir);
    }

    if(options){
        options.urls = param.urls;
        param = merge(param, options);
    }
    param.prjDir = prjDir;
    console.log(param);
    var fileReg = new RegExp(param.supportedFile);
    return function(req, res, next) {
        //远程请求的域名不能和访问域名一致，否则会陷入请求循环。
        if(req.headers.host === param.host){
            return;
        }
        var url = req.url;
        var prefix = url.indexOf(param.servlet + '?');
        //不包含combo的servlet，认为是单一文件
        if(prefix === -1){
            //combo不处理html文件，但是需要接管其他资源
            if(!fileReg.test(url)) {
                next();
                return;
            }

            var filteredUrl = filterUrl(url);
            res.setHeader('Content-Type', mime.lookup(filteredUrl));
            var singleFileContent = readFromLocal(filteredUrl);

            if(singleFileContent){
                res.end(singleFileContent);
                return;
            }

            var cachedFile = readFromCache(url);
            if(cachedFile){
                res.end(cachedFile);
                return;
            }

            //本地没有，从服务器获取  
            console.log('send http request:'+ param.host+ url);
            http.get({host: param.host, port: 80, path: url}, function(resp) {
                var buffs = [];
                if(resp.statusCode !== 200){
                    res.end('File ' + url + ' not found.');
                    return;
                }
                resp.on('data', function(chunk) {
                    buffs.push(chunk);
                });
                resp.on('end', function() {
                    var buff = joinbuffers(buffs);
                    
                    //fix 80% situation bom problem.quick and dirty
                    if(buff[0] === 239 && buff[1] === 187 && buff[2] === 191) {
                        buff = buff.slice(3, buff.length);
                    }
                    if(isBinFile(url)){
                        cacheFile(url, buff);
                        res.end(buff);
                        return;
                    }
                    var charset = isUtf8(buff) ? 'utf8' : 'gbk';
                    var singleFileContent = adaptCharset(buff, param.charset, charset);
                    cacheFile(url, buff, charset);
                    res.end(singleFileContent );
                    return;
                });
            }).on('error',function(e){
                console.log('Networking error:' + e.message);
                return;
            });
            return;
        }
        prefix = url.substring(0, prefix);
        console.log(prefix+'|'+param.servlet);
        var files = url.substring(prefix.length + param.servlet.length + 1, url.length);
        console.log(files);
        files = files.split(param.seperator, 1000);

        var reqArray = [];
        var prevNeedHttp = false ;//为循环做准备，用来判定上次循环的file是否需要通过http获取
        var needHttpGet = '';
        for(var i = 0, len = files.length; i < len; i++){
            var file = files[i];
            
            //combo URL有时候会多一个逗号
            if(file === "") continue;
            var fullPath = filterUrl(path.join(prefix, files[i]));
            if(i === 0 ){
                res.setHeader('Content-Type', mime.lookup(fullPath));
            }

            var fileContent = readFromLocal(fullPath);
            if(!fileContent){
                console.log('file not in local"'+fullPath);
                if(prevNeedHttp){
                    needHttpGet += ',' + file;
                    continue;
                }
                prevNeedHttp = true;
                needHttpGet = file;
                continue;
            }
            if(prevNeedHttp){
                reqArray.push({file: needHttpGet, ready: false});
            }
            prevNeedHttp = false;
            reqArray.push({file: file, content: fileContent, ready: true});
        }

        if(prevNeedHttp){
            reqArray.push({file: needHttpGet, ready:false});
        }
        console.log('array size: '+reqArray.length);

        var reqPath = prefix + param.servlet + '?';
        for(var i = 0, len = reqArray.length; i < len; i++){
            if(reqArray[i].ready){
                continue;
            }
            var cacheName = crypto.createHash('md5').update(reqArray[i].file).digest('hex');
            var cachedContent = readFromCache('/' + cacheName);
            if(cachedContent){
                reqArray[i].content = cachedContent;
                reqArray[i].ready = true;
                continue;
            }
            
            (function(id) {
                console.log('define request: '+ reqArray[i].file);
                http.get({host: param.host, port: 80, path: reqPath + reqArray[id].file}, function(resp) {
                    if(resp.statusCode !== 200){
                        reqArray[id].ready = true;
                        reqArray[id].content = 'File '+ reqArray[id].file +' not found.';
                        sendData();
                        return;
                    }

                    var buffs = [];
                    console.log('request: ' + reqPath + reqArray[id].file);
                    resp.on('data', function(chunk) {
                        buffs.push(chunk);
                    });
                    resp.on('end', function() {
                        reqArray[id].ready = true;
                        var buff = joinbuffers(buffs);

                        //fix 80% situation bom problem.quick and dirty
                        if(buff[0] === 239 && buff[1] === 187 && buff[2] === 191) {
                            buff = buff.slice(3, buff.length);
                        }
                        var fileName = crypto.createHash('md5').update(reqArray[id].file).digest('hex');
                        if(isBinFile(reqArray[id].file)){
                            reqArray[id].content = buff;
                            cacheFile('/'+fileName, buff);
                            return;
                        }
                        var charset = isUtf8(buff) ? 'utf8' : 'gbk';
                        reqArray[id].content = adaptCharset(buff, param.charset, charset);
                        cacheFile('/'+fileName, buff, charset);
                        sendData();
                    });
                }).on('error',function(e){
                    console.log('Networking error:' + e.message);
                });
            })(i);
        }

        var sendData = function(){
            for(var j = 0, len = reqArray.length; j < len; j++){
                if(reqArray[j].ready === false){
                    return;
                }
            }
            reqArray.forEach(function(reqNode){
                res.write(reqNode.content);
            });
            res.end();
        }
        
        //如果全部都在本地可以获取到，就立即返回内容给客户端
        sendData();
    }
}
