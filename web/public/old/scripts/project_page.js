// JavaScript Document by avi asheknazi

function checkNumber(){
	if(posnev == true){
		if(picNum==countImages){
				picNum=0;
		}else{
				picNum++;
		}}else{
		if(picNum==1){
				picNum=countImages;
		}else{
				picNum--;
		}
}}
var posnev = true;

function nextImage(){
	posnev = true;
	checkNumber();
	document.getElementById("big_image").src = imgs[picNum].src;
	document.getElementById("big_image").alt = titles[picNum];
	document.getElementById("textp").innerHTML = titles[picNum] + '<span class=""numbers"> [' + picNum + '/' + countImages + ']</span>';
}
function prevImage(){
	posnev = false;
	checkNumber();
	document.getElementById("big_image").src = imgs[picNum].src;
	document.getElementById("big_image").alt = titles[picNum];
	document.getElementById("textp").innerHTML = titles[picNum] + '<span class=""numbers"> [' + picNum + '/' + countImages + ']</span>';
}

//the draggable social function
$(document).ready(function(){
 $(function() {
	    
		//cache selector
		var images = $("#big_gallery img"),
		  title = $("title").text() || document.title;
		
	    //make images draggable
	    images.draggable({
		  //create draggable helper
		  helper: function() {
		    return $("<div>").attr("id", "helper").html("<span>" + title + "</span><img id='thumb' src='" + $(this).attr("src") + "'>").appendTo("body");
		  },
		  cursor: "pointer",
		  cursorAt: { left: -10, top: 20 },
		  zIndex: 99999,
		  //show overlay and targets
		  start: function() {
		    $("<div>").attr("id", "overlay").css("opacity", 0.7).appendTo("body");
			$("#tip").remove();
			$(this).unbind("mouseenter");
			$("#targets").css("left", ($("body").width() / 2) - $("#targets").width() / 2).slideDown();
		  },
		  //remove targets and overlay
		  stop: function() {
		    $("#targets").slideUp();
			$(".share", "#targets").remove();
		    $("#overlay").remove();
			$(this).bind("mouseenter", createTip);
		  }
		});
		
		//make targets droppable
		$("#targets li").droppable({
		  tolerance: "pointer",
		  //show info when over target
		  over: function() {
		    $(".share", "#targets").remove();
		    $("<span>").addClass("share").text("Share on " + $(this).attr("id")).addClass("active").appendTo($(this)).fadeIn();
		  },
		  drop: function() {
		    var id = $(this).attr("id"),
			  currentUrl = window.location.href,
			  baseUrl = $(this).find("a").attr("href");

			if (id.indexOf("twitter") != -1) {
			  window.location.href = baseUrl + "/home?status=" + title + ": " + currentUrl;
			} else if (id.indexOf("delicious") != -1) {
			  window.location.href = baseUrl + "/save?url=" + currentUrl + "&title=" + title;
			} else if (id.indexOf("facebook") != -1) {
			  window.location.href = baseUrl + "/sharer.php?u=" + currentUrl + "&t=" + title;
			}
		  }		  
		});
	  
	    var createTip = function(e) {
		  //create tool tip if it doesn't exist
		  ($("#tip").length === 0) ? $("<div>").html("<span>Drag this image to share the page<\/span><span class='arrow'><\/span>").attr("id", "tip").css({ left:e.pageX + 30, top:e.pageY - 16 }).appendTo("body").fadeIn(2000) : null;
		};
		
		images.bind("mouseenter", createTip);
		
		images.mousemove(function(e) {
		
		  //move tooltip
          $("#tip").css({ left:e.pageX + 30, top:e.pageY - 16 });
        });
	  
	    images.mouseleave(function() {
		
		  //remove tooltip
		  $("#tip").remove();
	    });
	  });
});

