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
function DeleterBot(setting){
	this.setting=setting;	//MediaWikiSetting
	if(!(setting instanceof MediaWikiSetting)){
		throw new Error("Invalid setting obj");
	}
	this.cookies={};	//Cookie
	//deleteトークンを取得しておく
	this.deleteToken=null;
	//503に対してリトライする回数
	this.retry_count=8;	//8回までリトライ
	//リクエストをためる
	this.active=false;	//現在通信中のリクエストがあるか
	this.requestQueue=[];	//{method,path,body,callback};
}
//setting
DeleterBot.prototype.bot_english_percentage=65;	//削除閾値
DeleterBot.prototype.bot_request_wait=150;	//リクエスト間隔（msec）

DeleterBot.prototype.request=function(method,path,body,callback){
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
			var charset="utf8";	//default
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

			var data="";	//貯める
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
DeleterBot.prototype.postGetJSON=function(path,body,callback){
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
DeleterBot.prototype.gotError=function(e){
	console.error('error:',e.message);
	throw e;
};
//クッキーを設定する
DeleterBot.prototype.setCookie=function(key,value){
	this.cookies[key]=value;
};
//ログ
DeleterBot.prototype.log=function(){
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
DeleterBot.prototype.useDB=function(callback){
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
DeleterBot.prototype.api=function(getobj,postobj,cb){
	//クエリはオブジェクトで表現
	getobj.format="json";
	this.postGetJSON("/api.php?"+objQuerify(getobj),objQuerify(postobj),cb);
	function objQuerify(obj){
		var keys=Object.keys(obj);
		var query=keys.map(function(x){
			return x+"="+encodeURIComponent(obj[x]);
		}).join("&");
		return query;
	}
};
//ログインする
DeleterBot.prototype.login=function(name,password,cb){
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
			this.api({
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
			}.bind(this));
		}else{
			//不測の事態
			console.error(result);
			this.gotError(new Error("Cannot login"));
		}
	}.bind(this));
};
//リスト取得クエリ(パラメータをobjで渡す）(paramに対して破壊的) listtype:"recentchanges"とか number:取得ページ数
//イテレータ関数を返す
DeleterBot.prototype.eachlist=function(param,listtype,number){
	param.action="query";
	param.list=listtype;
	//ページストア
	var pages=[], count=0;
	//次のリクエストオブジェクト
	var nextparam=param;	//1回目は引数通り

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
			var qco=result["query-continue"];
			var qcon=qco ? qco[listtype] : null;	//継続用オブジェクト
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
			pages=pages.concat(result.query[listtype]);
			iterate(cb);
		});
	}.bind(this);
};
//ページ取得クエリ
DeleterBot.prototype.query=function(param,prop,cb){
	param.action="query";
	param.prop=prop;

	this.api(param,{},function(result){
		cb(result.query);
	});
};
//ページ削除クエリ
DeleterBot.prototype.deletePage=function(title,cb){
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
DeleterBot.prototype.pageContent=function(title,cb){
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
DeleterBot.prototype.englishRate=function(title,cb){
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
DBManager.prototype.savePage=function(title,content,mode,callback){
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
	var db=new mongodb.Db(s.database, new mongodb.Server(s.host,s.port),{w:1});
	db.open(function(err,client){
		if(err){
			bot.gotError(err);
			return;
		}
		if(s.username && s.password){
			db.authenticate(s.username,s.password,function(err){
				if(err){
					bot.gotError(err);
					return;
				}
				//成功
				gotClient(client);
			});
		}else{
			//成功
			gotClient(client);
		}
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
MongoDBManager.prototype.savePage=function(title,content,mode,callback){
	var bot=this.bot;
	this.collection("pages",function(coll){
		//mode: "new":新規作成のログ
		var doc={
			title:title,
			content:content,
			mode:mode,
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
var argv=process.argv.slice(2);
//method set this[flagname] to true/false;
argv.setFlag=function(flagname){
	//arguments: param to find!(or)
	this[flagname]= Array.prototype.slice.call(arguments,1).some.call(arguments,function(x){
		return this.indexOf(x)>=0;
	},this);
};
argv.setFlag("help","-h","--help");
argv.setFlag("silent","-s","--silent");
argv.setFlag("nocolor","-c","--nocolor");
argv.setFlag("dry","-d","--dry");
argv.setFlag("check","--check");

//help mode
if(argv.help){
	console.log(["commandline params:",
			"\t-h, --help: show this message",
			"\t-s, --silent: no debug log",
			"\t-nc, --nocolor: non-coloured log",
			"\t-d, --dry: dry run(no delete)",
			"\t--check: check pages that remain",
			].join("\n"));
			process.exit();
}
// perform
var setting=new MediaWikiSetting({
	hostname:"some-mediawiki.org",

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
var username="***", password="***";
var bot=new DeleterBot(setting);
if(argv.check){
	//DBチェックモード
	check(bot,argv);
}else{
	//普通
	normal_delete(bot,argv);
}

function normal_delete(bot,argv){
	bot.useDB(function(db){
		bot.login(username,password,function(){
			//ログインしたら最新の変更をチェック
			var deletecount=0;
			var iterator=bot.eachlist({
				rctype:"new",
				rcshow:"!bot",
				rcprop:"user|title|ids|flags",
			},"recentchanges",500);
			iterator(function handle(page){
				//page: ひとつのページの情報
				if(page==null){
					bot.log((deletecount?deletecount:"no")+" pages are deleted.");
					db.close();
					return;	//終わり
				}
				//新規作成ページ（怪しい）
				if(page.type==="new"){
					bot.englishRate(page.title,function(rate,content){
						var rateStr=(rate*100).toPrecision(3)+"%";
						if(rate*100 >= bot.bot_english_percentage){
							bot.log(page.title,rateStr.red);
							//削除レートである
							if(!argv.dry){
								//本番
								bot.deletePage(page.title,function(){
									//次へ
									iterator(handle);
								});
								deletecount++;
							}else{
								iterator(handle);
							}
						}else{
							bot.log(page.title,rateStr.blue);
							//削除レート未満だ。保存しておく
							db.book();
							db.savePage(page.title,content,"new",function(){
								//次へ
								db.release();
								iterator(handle);
							});
						}
					});
				}
				return true;
			});
		});
	});
}
//DB内のやつをどうにかする
function check(bot,argv){
	if(!process.stdout.isTTY){
		bot.gotError("it's for TTY");
		return;
	}
	bot.useDB(function(db){
		bot.login(username,password,function(){
			//Mediawikiにログインした。DBにたまったやつを見ていく
			argv.silent=true;	//もうbot.logは出さない
			db.countPages(function(number){
				var index=1;
				db.iteratePages(function(iterator){
					var nowdoc=null;	//現在見ているやつ
					//入力受付
					var stdin=process.stdin;
					stdin.setRawMode(true);
					stdin.setEncoding("utf8");
					stdin.resume();
					stdin.on("data",function(key){
						if(key==="\u0003"){
							//Ctrl-Cらしい!
							//やめる
							console.log("");
							argv.silent=false;
							stdin.pause();
							db.close();
							return;
						}
						process.stdout.write(key);
						if(key==="d" || key==="D"){
							//削除しろ!
							if(nowdoc){
								(function(title){
									db.book();
									bot.deletePage(title,function(){
										//DBからも削除
										db.deletePage(title,function(){
											db.release();
										});
									});
								})(nowdoc.title);
							}
							index++;
							iterator(handle);
						}else if(key==="k" || key==="K"){
							//残す
							if(nowdoc){
								(function(title){
									db.book();
									db.deletePage(title,function(){
										db.release();
									});
								})(nowdoc.title);
							}
							index++;
							iterator(handle);
						}
					});
					iterator(handle);
					function handle(doc){
						if(!doc){
							//もう終わりだ
							console.log("");
							stdin.pause();
							db.close();
							argv.silent=false;
							return;
						}
						nowdoc=doc;
						//内容を表示
						//全部消す。カーソルを左上へ
						console.log(process.stdout.isTTY);
						if(process.stdout.isTTY){
							console.log(process.stdout.getWindowSize());
						}
						process.stdout.write("\u001b[2J\u001b[;f");
						//内容
						console.log("\n"+doc.content);
						//1行めにタイトル表示
						process.stdout.write("\u001b[;f\u001b[2K");
						console.log(doc.title.green);
						//最終行へ
						var size=process.stdout.getWindowSize();
						process.stdout.write("\u001b["+size[1]+";0f");
						process.stdout.write((index+"/"+number).yellow+" ");
						process.stdout.write("type D to delete; K to keep:".blue);
					};
				});
			});
		});
	});
}
