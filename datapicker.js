var botbot=require('./botbot');

var db={
    host:"localhost",
    port:27017,
    username:"test",
    password:"test",
    database:"deleter-bot",
};
var from={
    hostname:"wiki.ssssjima.net",
    basepath:"",
    username:"username",
    password:"password"
};
var to={
    hostname:"hakopedia.uhyohyo.net",
    basepath:"/w",
    username:"username",
    password:"password"
};
//-----------------------------
//get argv
var argv=require("minimist")(process.argv.slice(2),{
    boolean:["help","silent","dry"]
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
switch(command){
    case "help":
        usage();
        break;
    case "pagelist":
        //ページのリストを取得してDBに保存
        pagelist();
        break;
    case "push":
        //ページを書く
        push();
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

function pagelist(){
    var setting=new botbot.MediaWikiSetting({
        hostname:from.hostname,
        basepath:from.basepath,

        useDB:"mongodb",
        db:db,
    });
    var bot=new botbot.Bot(argv,setting);
    bot.useDB(function(){
        bot.login(from.username,from.password,listCategories);
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
            bot.db.savePage({
                title:title,
                content:content
            },callback);
        }

    }
}
function push(){
    var setting=new botbot.MediaWikiSetting({
        hostname:to.hostname,
        basepath:to.basepath,

        useDB:"mongodb",
        db:db,
    });
    var bot=new botbot.Bot(argv,setting);
    bot.useDB(function(){
        bot.login(to.username,to.password,function(){
            //get edit token
            bot.api({
                action:"tokens",
                type:"edit"
            },{},function(result){
                var edittoken=result.tokens.edittoken;
                pushPages(edittoken);
            });
        });
    });
    function pushPages(edittoken){
        var pushedCount=0;
        bot.db.iteratePages({
            pushed:{$ne:true}
        },function(iterate){
            iterate(function handler(doc){
                if(doc==null){
                    //終了
                    console.log("done.");
                    bot.db.close();
                    return;
                }
                //これを書き込む
                bot.api({
                    action:"edit",
                    title:doc.title,
                    text:doc.content,
                    bot:"",
                    createonly:"",
                    summary:"データ移行",
                    token:edittoken
                },{},function(result){
                    if(result.edit.result==="Success"){
                        //成功した
                        bot.db.savePage({
                            title:doc.title,
                            content:doc.content,
                            pushed:true
                        },function(){
                            //書き込みおわり
                            pushedCount++;
                            if(pushedCount%100===0){
                                console.log("pushed "+pushedCount+" pages");
                            }
                            iterate(handler);
                        });
                    }else{
                        console.log("Failed to edit "+doc.title+" "+result);
                    }
                });
            });
        });
    }
}

