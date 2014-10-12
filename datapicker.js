var http=require('http'), url=require('url'),util=require('util'), colors=require('colors');

function MediaWikiSetting(obj){
    //setting object
    this.hostname=obj.hostname || "localhost";
    //db
    this.useDB=obj.useDB;
    this.db=obj.db || {};
}
MediaWikiSetting.prototype.getObj=function(path,method){
    //obj for http.get
    var u=url.parse(path);
    return {
        hostname:u.hostname || this.hostname,
        protocol: u.protocol || "http:",
        port:u.port || 80,
        path:u.path,
        method:method|| "GET",
    };
};
function Bot(setting){
    this.setting=setting;   //MediaWikiSetting
    if(!(setting instanceof MediaWikiSetting)){
        throw new Error("Invalid setting obj");
    }
    this.cookies={};    //Cookie
    //deleteトークンを取得しておく
    this.deleteToken=null;
    //503に対してリトライする回数
    this.retry_count=8; //8回までリトライ
    //リクエストをためる
    this.active=false;  //現在通信中のリクエストがあるか
    this.requestQueue=[];   //{method,path,body,callback};
}
//setting
Bot.prototype.bot_request_wait=0;   //リクエスト間隔（msec）

Bot.prototype.request=function(method,path,body,callback){
    setTimeout(function(){
        if(this.active){
            //まだ通信中!キューにためる
            this.requestQueue.push({
                method:method,
                path:path,
                body:body,
                callback:callback,
            });
            return;
        }
        this.active=true;
        var pathobj=this.setting.getObj(path,method);
        //cookie追加
        var ck=Object.keys(this.cookies);
        if(ck.length>0){
            //
            var cookieHeader=ck.map(function(key){
                return key+"="+this.cookies[key];
            },this).join("; ");
            pathobj.headers={
                "Cookie": cookieHeader,
            };
        }
        var req=http.request(pathobj,function(res){
            var status=res.statusCode;
            this.log(String(status).green,path.grey);
            if(status===301 || status===302 || status===303 || status===307){
                //redirect
                this.get(res.headers.location,callback);
                abort();
                return;
            }
            if(status>=400){
                //あれれーーーー
                if(status===503 && this.retry_count>0){
                    //一時的過負荷。リトライしてみる
                    this.retry_count--;
                    setTimeout(function(){
                        this.request(method,path,body,callback);
                    }.bind(this),10000);
                    return;
                }else{
                    this.gotError(new Error("aborted."));
                    abort();
                    return;
                }
            }
            //まずtypeを解析
            var type=res.headers["content-type"];
            var typeres=type.match(/^\s*([-\w]+)\/([-\w]+)\s*(?:;\s*(\S*))?/);
            if(!typeres){
                this.gotError(new Error("Unknown content-type: "+type));
                abort();
                return;
            }
            //受け付けられないやつ
            if(typeres[1]!=="text"){
                if(typeres[1]!=="application" || (typeres[2]!=="json" && typeres[2]!=="xml")){
                    //json,xml以外はダメ
                    this.gotError(new Error("Unacceptable content-type:"+type));
                    abort();
                    return;
                }
            }
            //charsetを解析
            var charset="utf8"; //default
            if(typeres[3]){
                //parameter
                var typeres2=typeres[3].match(/charset\s*=\s*([^\s;]+)/i);
                if(typeres2){
                    //指定あった
                    if(/utf-?8/i.test(typeres2[1])){
                        charst="utf8";
                    }else{
                        this.gotError(new Error("unacceptable charset:"+type));
                        abort();
                        return;
                    }
                }
            }
            res.setEncoding(charset);

            var data="";    //貯める
            res.on("data",function(chunk){
                data+=chunk;
            });
            //res: Response
            res.on("end",function(){
                //リクエスト終了した
                this.active=false;
                if("function"===typeof callback){
                    callback(data);
                }
                if(!this.active && this.requestQueue.length>0){
                    //次のリクエストがたまっている
                    var obj=this.requestQueue.shift();
                    this.request(obj.method,obj.path,obj.body,obj.callback);
                    delete obj;
                }
            }.bind(this));
            //cookieの処理
            var c=res.headers["set-cookie"];
            if(Array.isArray(c)){
                //肝心部分のみ
                c.forEach(function(str){
                    var result=str.match(/^([-\w]+)\s*=\s*([^\s;]+)/);
                    if(result){
                        this.setCookie(result[1],result[2]);
                    }
                },this);
            }
            //リクエスト終了処理
            function abort(){
                delete callback;
                res.destroy();
            }
        }.bind(this));
        //クッキー
        if(body){
            req.write(body);
        }   
        req.end();
        req.on("error",function(e){
            this.gotError(e);
            delete callback;
            req.abort();
            this.active=false;
        }.bind(this));
    }.bind(this),this.bot_request_wait);
};
Bot.prototype.postGetJSON=function(path,body,callback){
    this.request("POST",path,body,function(res){
        //json化
        try{
            var obj=JSON.parse(res);
        }catch(e){
            bot.log(res.slice(0,1024*2));
            this.gotError(e);
        }
        callback(obj);
    }.bind(this));
};

//エラーに出会った
Bot.prototype.gotError=function(e){
    console.error('error:',e.message);
    throw e;
};
//クッキーを設定する
Bot.prototype.setCookie=function(key,value){
    this.cookies[key]=value;
};
//ログ
Bot.prototype.log=function(){
    if(argv.nocolor){
        //color符号削除
        for(var i=0,l=arguments.length;i<l;i++){
            arguments[i]=arguments[i].replace(/\u001b\[\w\w\w/g,"");
        }
    }
    if(!argv.silent){
        console.log.apply(console,arguments);
    }
};
//----------------------------------------
//DB使用準備
Bot.prototype.useDB=function(callback){
    //DBマネージャを準備
    var c=this.setting.useDB==="mongodb" ? MongoDBManager : DBManager;
    var db=this.db= new c(this,this.setting.db);
    db.prepare(function(){
        callback(db);
    });
};
//-----------------------------------------
//Mediawikiに対する処理
//apiに投げる
Bot.prototype.api=function(getobj,postobj,cb){
    //クエリはオブジェクトで表現
    getobj.format="json";
    this.postGetJSON("/api.php?"+objQuerify(getobj),objQuerify(postobj),function(result){
        if(result.error){
            console.error(util.inspect(result.error,5));
            throw "Error";
        }
        cb(result);
    });
    function objQuerify(obj){
        var keys=Object.keys(obj);
        var query=keys.map(function(x){
            return x+"="+encodeURIComponent(obj[x]);
        }).join("&");
        return query;
    }
};
//ログインする
Bot.prototype.login=function(name,password,cb){
    this.api({
        action:"login",
        lgname:name,
        lgpassword:password,
    },{
    },function handler(result){
        if(result.login.result==="NeedToken"){
            //トークンが無かった（セット済み）　もう一回
            this.api({
                action:"login",
                lgname:name,
                lgpassword:password,
                lgtoken: result.login.token,
            },{},handler.bind(this));
        }else if(result.login.result==="Success"){
            //成功した クッキーをセット
            var cookieprefix=result.login.cookieprefix;
            this.setCookie(cookieprefix+"UserName",result.login.lgusername);
            this.setCookie(cookieprefix+"UserID",result.login.lguserid);
            this.setCookie(cookieprefix+"Token",result.login.lgtoken);
            
            //deleteトークンを取得
            /*this.api({
                action:"query",
                prop:"info",
                intoken:"delete",
                titles:"メインページ",
            },{},function(result){
                this.deleteToken=result.query.pages[1].deletetoken;
                //cb();
                //次に標識を確認（可動許可がでているか）
                this.pageContent("利用者:"+name,function(cont){
                    //標識を探す
                    if(!cont){
                        console.error("利用者:"+name+" is not available");
                        return;
                    }
                    var result=cont.match(/BOT\s*:\s*(\S+)/);
                    if(!result){
                        console.error("no 標識 was found. not working");
                        return;
                    }
                    if(result[1]!=="稼働"){
                        console.error("標識 says "+result[0]+". not working");
                        return;
                    }
                    //OK!
                    cb();
                });
            }.bind(this));*/
            cb();
        }else{
            //不測の事態
            console.error(result);
            this.gotError(new Error("Cannot login"));
        }
    }.bind(this));
};
//リスト取得クエリ(パラメータをobjで渡す）(paramに対して破壊的) listtype:"recentchanges"とか number:取得ページ数
//イテレータ関数を返す
Bot.prototype.eachlist=function(param,number){
    param.action="query";
    //ページストア
    var pages=[], count=0;
    //次のリクエストオブジェクト
    var nextparam=param;    //1回目は引数通り

    var listtype = param.list || param.generator;

    var t=this;

    return function iterate(cb){
        if(count++>=number){
            //もういっぱいだ
            cb(null);
            return;
        }
        if(pages.length>0){
            //返す
            cb(pages.shift());
            return;
        }   
        //もうないけど継続したい
        if(!nextparam){
            //継続できない
            cb(null);
            return;
        }
        this.api(nextparam,{},function handler(result){
            //ページを取得した
            console.log(util.inspect(result,{depth:6}));
            var qco=result["query-continue"];
            
            var qcon=qco ? qco[listtype] : null;    //継続用オブジェクト
            if(qcon){
                //次回のリクエスト準備
                nextparam={};
                for(var key in param){
                    nextparam[key]=param[key];
                }
                //qconので上書き
                for(var key in qcon){
                    nextparam[key]=qcon[key];
                }
            }else{
                //もう終了
                nextparam=null;
            }
            //ページ追加
            var arr=result.query && result.query[param.generator ? "pages" : listtype];
            if(arr!=null){
                pages=pages.concat(Array.isArray(arr) ? arr : Object.keys(arr).map(function(key){
                    return arr[key];
                }));
            }
            iterate(cb);
        });
    }.bind(this);
};
//ページ取得クエリ
Bot.prototype.query=function(param,prop,cb){
    param.action="query";
    param.prop=prop;

    this.api(param,{},function(result){
        cb(result.query);
    });
};
//ページ削除クエリ
Bot.prototype.deletePage=function(title,cb){
    this.api({
        action:"delete",
        title:title,
        token:this.deleteToken,
        reason:"spam",
    },{},function(result){
        //console.log(result);
        bot.log("delete".red,title);
        if(cb){
            cb();
        }
    });
};
//ページの内容を取得
Bot.prototype.pageContent=function(title,cb){
    this.query({
        rvprop:"ids|content",
        titles:title,
    },"revisions",function(result){
        //目的のページ
        for(var key in result.pages){
            //最初のやつ(1つしかない)
            var pagedata=result.pages[key];
            if(pagedata.missing!=null || !pagedata.revisions){
                this.log("warn ".yellow,("'"+pagedata.title+"'").cyan,"doesn't exist");
                cb(null);
            }else{
                var revdata=pagedata.revisions[0];
                var content=revdata["*"];
                cb(content);
            }
            return;
        }
    }.bind(this));
};

//応用的: ページ名からそのページの英字含有率取得
Bot.prototype.englishRate=function(title,cb){
    this.pageContent(title,function(content){
        //英字含有率計算
        if(!content){
            //計算できない
            cb(Number.NaN);
            return;
        }
        var full=content.length;
        //英字除去
        var remains=content.replace(/(?:-|\w)/g,"").length;
        var english_rate=(full-remains)/full;
        cb(english_rate,content);
        return;
    });
};
//----------------------------
//DBマネージャ
function DBManager(bot,dbsetting){
    this.bot=bot;
    this.dbsetting=dbsetting;
    //DB処理予約（まだ待ってね）
    this.bookcount=0;
    this.closing_flg=false;
}
DBManager.prototype.prepare=function(callback){
    callback();
};
DBManager.prototype.close=function(){
    if(this.bookcount===0){
        this.closeReal();
    }
    this.closing_flg=true;
};
DBManager.prototype.closeReal=function(){
};
DBManager.prototype.book=function(){
    if(this.closing_flg){
        //もうだめだ
        this.bot.gotError("db is closing");
        return;
    }
    this.bookcount++;
};
DBManager.prototype.release=function(){
    this.bookcount--;
    if(this.closing_flg && this.bookcount===0){
        this.closeReal();
    }
};
DBManager.prototype.savePage=function(title,content,callback){
    //dummy!!!
    callback();
}
DBManager.prototype.deletePage=function(title,callback){
    if(callback){
        callback();
    }
}
DBManager.prototype.iteratePages=function(callback){
    //dummy!!!
    callback(function(callback){
        callback(null);
    });
};
DBManager.prototype.countPages=function(callback){
    callback(0);
};
//MongoDB
function MongoDBManager(){
    DBManager.apply(this,arguments);
}
util.inherits(MongoDBManager,DBManager);
MongoDBManager.prototype.prepare=function(callback){
    var _this=this;
    var bot=this.bot;
    var mongodb=require('mongodb');
    var s=this.dbsetting;
    mongodb.MongoClient.connect("mongodb://"+s.host+":"+s.port/*+(s.username&&s.password ? "@"+s.username+":"+s.password : "")*/+"/"+s.database+"?w=1",function(err,client){
        if(err){
            bot.gotError(err);
            return;
        }
        gotClient(client);
    });
    function gotClient(client){
        _this.client=client;
        //インデックス準備
        client.ensureIndex("pages",{title:1},function(err,index_name){
            if(err){
                bot.gotError(err);
                return;
            }
            callback(client);
        });
    }
};
//終了
MongoDBManager.prototype.closeReal=function(){
    this.client.close();
};
//コレクション取得
MongoDBManager.prototype.collection=function(name,callback){
    var bot=this.bot;
    this.client.collection(name,function(err,coll){
        if(err){
            bot.gotError(err);
            return;
        }
        callback(coll);
    });
};
//具体的操作
//ページの情報を保存（怪しい）
MongoDBManager.prototype.savePage=function(title,content,callback){
    var bot=this.bot;
    this.collection("pages",function(coll){
        var doc={
            title:title,
            content:content,
        };
        coll.update({title:title},doc,{
            safe:true,
            upsert:true,
        },function(err){
            if(err){
                bot.gotError(err);
                return;
            }
            callback();
        });
    });
};
MongoDBManager.prototype.deletePage=function(title,callback){
    var bot=this.bot;
    this.collection("pages",function(coll){
        coll.remove({title:title},{w:1},function(err){
            if(err){
                bot.gotError(err);
                return;
            }
            if(callback)callback();
        });
    });
};
//保存されたページをアレする
MongoDBManager.prototype.iteratePages=function(callback){
    var bot=this.bot;
    this.collection("pages",function(coll){
        var cursor=coll.find();
        callback(function iterate(callback){
            cursor.nextObject(function(err,doc){
                if(err){
                    bot.gotError(err);
                    return;
                }
                callback(doc);
            });
        });
    });
};
//ページを数える
MongoDBManager.prototype.countPages=function(callback){
    var bot=this.bot;
    this.collection("pages",function(coll){
        coll.count(function(err,count){
            if(err){
                bot.gotError(err);
                return;
            }
            callback(count);
        });
    });
};

//-----------------------------
//get argv
var argv=require("minimist")(process.argv.slice(2),{
    boolean:["help","silent","dry"]
});
var setting=new MediaWikiSetting({
    hostname:"wiki.ssssjima.net",

    useDB:"mongodb",
    db:{
        host:"localhost",
        port:27017,
        username:"test",
        password:"test",
        database:"deleter-bot",
    },
});
//wiki user
var username="username", password="password";

//-------
//
var command=argv._[0];

//help mode
if(argv.h || argv.help){
    usage();
    process.exit();
}
// perform
var bot=new Bot(setting);
switch(command){
    case "help":
        usage();
        break;
    case "pagelist":
        //ページのリストを取得してDBに保存
        pagelist(bot,argv);
        break;
    default:
        console.error("error: unknown command "+command);
        usage();
        break;
}
function usage(){
    console.log(["usage: "+process.argv[0]+" "+process.argv[1]+" [options] command",
        "commands:",
        "\tpagelist",

        "options:",
        "\t-h, --help: show this message",
        //"\t-s, --silent: no debug log",
        //"\t--nocolor: non-coloured log",
        //"\t-d, --dry: dry run(no delete)",
        //"\t--check: check pages that remain",
    ].join("\n"));
}

function pagelist(bot,argv){
    bot.useDB(function(){
        bot.login(username,password,listCategories);
    });
    function listCategories(){
        //ログインしたらカテゴリ一覧を取得
        var categories=[];  //カテゴリ名一覧
        var ite=bot.eachlist({
            list:"allcategories",
            aclimit:"500",
        },Infinity);
        ite(function handler(obj){
            if(obj==null){
                //おわり
                listNamespaces(categories);
                return;
            }
            categories.push(obj["*"]);
            ite(handler);
        });
    }
    function listNamespaces(categories){
        bot.api({
            action:"query",
            meta:"siteinfo",
            siprop:"namespaces"
        },{},function(result){
            //specialなやつの
            var namespaces=[];
            for(var key in result.query.namespaces){
                var catobj=result.query.namespaces[key];
                if(catobj.id>=0 && catobj.canonical && catobj.canonical!=="File" && catobj.canonical!=="File talk" && catobj.canonical!=="User" && catobj.canonical!=="User talk"){
                    //これは移すべき
                    namespaces.push(catobj.id);
                }
            }
            getPages(categories,namespaces);
        });
    }
    function getPages(categories,namespaces){
        oneCategory(0);
        var pageCount=0;
        function oneCategory(index){
            var catName=categories[index];
            if(catName==null){
                //おわり
                oneNamespace(0);
                return;
            }
            var ite=bot.eachlist({
                generator:"categorymembers",
                gcmtitle:"Category:"+catName,
                gcmtype:"page",
                gcmlimit:"max",
                prop:"revisions",
                rvprop:"content",
            },Infinity);
            var cnt=0;
            ite(function handler(obj){
                //console.log(obj);
                if(obj==null){
                    //全部みたので次のカテゴリへ
                    oneCategory(index+1);
                    return;
                }
                var title=obj.title;
                var content=obj.revisions[0]["*"];
                delete obj;
                //スパムではないのでDBに保存
                savePage(title,content,function(){
                    ite(handler);
                });
            });
        }
        function oneNamespace(index){
            var namespaceId=namespaces[index];
            if(namespaceId==null){
                //おわり

                return;
            }
            var ite=bot.eachlist({
                generator:"allpages",
                gapnamespace:namespaceId,
                gaplimit:"max",
                prop:"revisions",
                rvprop:"content",
            },Infinity);
            var cnt=0;
            ite(function handler(obj){
                //console.log(obj);
                if(obj==null){
                    //全部みたので次のカテゴリへ
                    oneNamespace(index+1);
                    return;
                }
                var title=obj.title;
                var content=obj.revisions[0]["*"];
                delete obj;
                //スパムではないのでDBに保存
                savePage(title,content,function(){
                    ite(handler);
                });


            });
        }
        function savePage(title,content,callback){
            //DBにこのページを保存
            pageCount++;
            if(pageCount%100==0){
                console.log("saved "+pageCount+" pages");
            }
            bot.db.savePage(title,content,callback);
        }

    }
}

