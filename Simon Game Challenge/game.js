

let buttonColours= ["red", "blue", "green", "yellow"]
let gamePattern = []
let userClickedPattern=[];
var started = false;
var level = 0

//at the start of the game
$(document).keypress(function() {
    if (!started) {
  
      //3. The h1 title starts out saying "Press A Key to Start", when the game has started, change this to say "Level 0".
      $("#level-title").text("Level " + level);
      nextSequence();
      started = true;
    }
  });

  //button press
  $(".btn").click(function() {
    
    var userChosenColour = $(this).attr("id");
    userClickedPattern.push(userChosenColour);
    playSound(userChosenColour);
    animatePress(userChosenColour);
    if (userClickedPattern.length===level){
    checkAnswer() 
    }

  });

  //next sequence
function nextSequence() {
    userClickedPattern = []
    //4. Inside nextSequence(), increase the level by 1 every time nextSequence() is called.
    level++;
  
    //5. Inside nextSequence(), update the h1 with this change in the value of level.
    $("#level-title").text("Level " + level);
  
    var randomNumber = Math.floor(Math.random() * 4);
    var randomChosenColour = buttonColours[randomNumber];
    gamePattern.push(randomChosenColour);
    
    $("#" + randomChosenColour).fadeIn(100).fadeOut(100).fadeIn(100);
    playSound(randomChosenColour);
        
  }

//playing sound

function playSound(name){

    var audio2= new Audio("./sounds/"+name+".mp3");
    audio2.play();

}

//animation for pressed button
function animatePress(currentColour) {
    $("#" + currentColour).addClass("pressed");
    setTimeout(function(){$("#" + currentColour).removeClass("pressed");},100);

}

function checkAnswer() {
    console.log(userClickedPattern);
    console.log(gamePattern);
    if(JSON.stringify(userClickedPattern)===JSON.stringify(gamePattern)){
        console.log("Success");
        setTimeout(nextSequence(),5000);
        
    }

    else {
    var audio3= new Audio("./sounds/wrong.mp3");
    audio3.play();
    $("body").addClass("game-over");
    setTimeout(function(){$("body").removeClass("game-over");},100);
    $("#level-title").text("Game Over, Press Any Key to Restart");
    startOver()
    console.log("wrong") ;}
}

function startOver(){
    started = false;
    level = 0;
    gamePattern = [];     
}

